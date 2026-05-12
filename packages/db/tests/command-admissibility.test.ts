import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("command admissibility helpers", () => {
  test("accepts valid commands and writes command/event/outbox transactionally", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const result = services.requestCommand({
        id: "command_stop",
        projectId: "project_a",
        taskId: "task_running",
        sessionId: "session_running",
        type: "stop",
        requestedBy: "operator-test",
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.command.type).toBe("stop");
      expect(result.event.type).toBe("command.queued");
      expect(result.outbox.routingKey).toBe("project.project_a.control");
      expect(countRows(database, "orchestrator_commands")).toBe(1);
      expect(countRows(database, "events")).toBe(1);
      expect(countRows(database, "outbox")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("returns structured invalid state errors", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);

      expect(
        services.requestCommand({ projectId: "project_a", taskId: "task_running", sessionId: "session_failed", type: "interrupt" }),
      ).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "interrupt requires running session; got failed" },
      });
      expect(services.requestCommand({ projectId: "project_a", taskId: "task_queued", type: "retry" })).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "retry requires terminal task; got queued" },
      });
    } finally {
      database.close();
    }
  });

  test("detects command conflicts for stop cancel retry cleanup interrupt and steering commands", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const cases = [
        { id: "stop_1", type: "stop", taskId: "task_running", sessionId: "session_running" },
        { id: "interrupt_1", type: "interrupt", taskId: "task_running", sessionId: "session_running" },
        { id: "steer_1", type: "steer", taskId: "task_running", sessionId: "session_running" },
        { id: "cancel_1", type: "cancel", taskId: "task_queued" },
        { id: "retry_1", type: "retry", taskId: "task_failed" },
        { id: "cleanup_1", type: "cleanup", taskId: "task_failed", sessionId: "session_failed" },
      ] as const;

      for (const command of cases) {
        const first = services.requestCommand({ projectId: "project_a", ...command });
        const second = services.requestCommand({ projectId: "project_a", ...command, id: `${command.id}_duplicate` });

        expect(first.ok).toBe(true);
        expect(second).toEqual({
          ok: false,
          error: { code: "conflict", message: `conflicting command already queued or running: ${command.id}` },
        });
      }
    } finally {
      database.close();
    }
  });

  test("atomically claims queued commands in creation order and returns no-work when drained", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const first = services.requestCommand({
        id: "command_stop",
        projectId: "project_a",
        taskId: "task_running",
        sessionId: "session_running",
        type: "stop",
        payload: { reason: "manual" },
      });
      const second = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_queued", type: "cancel" });
      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);

      const claimed = services.claimNextCommand({ projectId: "project_a" });
      const next = services.claimNextCommand({ projectId: "project_a" });
      const noWork = services.claimNextCommand({ projectId: "project_a" });

      expect(claimed).toMatchObject({
        ok: true,
        command: {
          id: "command_stop",
          projectId: "project_a",
          taskId: "task_running",
          sessionId: "session_running",
          type: "stop",
          status: "running",
          payload: { reason: "manual" },
        },
        event: { projectId: "project_a", type: "command.claimed" },
        outbox: { projectId: "project_a", routingKey: "project.project_a.control" },
      });
      expect(next).toMatchObject({ ok: true, command: { id: "command_cancel", status: "running", payload: {} } });
      expect(noWork).toEqual({ ok: false, reason: "no_queued_command" });
      expect(
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM orchestrator_commands WHERE id = 'command_cancel' AND status = 'running'").get()
          ?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test("repeated command claims never duplicate the same queued command", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const requested = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_queued", type: "cancel" });
      expect(requested.ok).toBe(true);

      const first = services.claimNextCommand({ projectId: "project_a" });
      const second = services.claimNextCommand({ projectId: "project_a" });

      expect(first).toMatchObject({ ok: true, command: { id: "command_cancel" } });
      expect(second).toEqual({ ok: false, reason: "no_queued_command" });
      expect(countRows(database, "orchestrator_commands")).toBe(1);
      expect(countRows(database, "events")).toBe(2);
      expect(countRows(database, "outbox")).toBe(2);
    } finally {
      database.close();
    }
  });

  test("reports command started succeeded and failed with idempotent duplicate reports", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const stop = services.requestCommand({ id: "command_stop", projectId: "project_a", taskId: "task_running", sessionId: "session_running", type: "stop" });
      const cancel = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_queued", type: "cancel" });
      expect(stop.ok).toBe(true);
      expect(cancel.ok).toBe(true);
      services.claimNextCommand({ projectId: "project_a" });
      services.claimNextCommand({ projectId: "project_a" });

      const started = services.reportCommandStarted({ projectId: "project_a", commandId: "command_stop" });
      const succeeded = services.reportCommandSucceeded({ projectId: "project_a", commandId: "command_stop" });
      const duplicateSucceeded = services.reportCommandSucceeded({ projectId: "project_a", commandId: "command_stop" });
      const failed = services.reportCommandFailed({ projectId: "project_a", commandId: "command_cancel", errorMessage: "provider stopped" });
      const duplicateFailed = services.reportCommandFailed({ projectId: "project_a", commandId: "command_cancel", errorMessage: "provider stopped" });

      expect(started).toMatchObject({ ok: true, idempotent: true, command: { id: "command_stop", status: "running" } });
      expect(succeeded).toMatchObject({
        ok: true,
        idempotent: false,
        command: { id: "command_stop", status: "succeeded", errorMessage: null },
        event: { type: "command.succeeded" },
      });
      expect(duplicateSucceeded).toMatchObject({ ok: true, idempotent: true, command: { id: "command_stop", status: "succeeded" } });
      expect(failed).toMatchObject({
        ok: true,
        idempotent: false,
        command: { id: "command_cancel", status: "failed", errorMessage: "provider stopped" },
        event: { type: "command.failed" },
      });
      expect(duplicateFailed).toMatchObject({ ok: true, idempotent: true, command: { id: "command_cancel", status: "failed" } });
      expect(database.query<{ status: string; error_message: string | null }, []>("SELECT status, error_message FROM orchestrator_commands WHERE id = 'command_cancel'").get()).toEqual({
        status: "failed",
        error_message: "provider stopped",
      });
    } finally {
      database.close();
    }
  });

  test("rejects unsafe command report transitions", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const queued = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_queued", type: "cancel" });
      expect(queued.ok).toBe(true);

      expect(services.reportCommandSucceeded({ projectId: "project_a", commandId: "command_cancel" })).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "succeeded report requires running command; got queued" },
      });
      expect(services.reportCommandFailed({ projectId: "project_a", commandId: "missing" })).toEqual({
        ok: false,
        error: { code: "not_found", message: "command not found: missing" },
      });
      services.claimNextCommand({ projectId: "project_a" });
      const failed = services.reportCommandFailed({ projectId: "project_a", commandId: "command_cancel" });
      expect(failed).toMatchObject({ ok: true, command: { status: "failed", errorMessage: "command failed without details" } });
      expect(services.reportCommandSucceeded({ projectId: "project_a", commandId: "command_cancel" })).toEqual({
        ok: false,
        error: { code: "conflict", message: "command command_cancel is already failed" },
      });
    } finally {
      database.close();
    }
  });

  test("rejects missing command scope", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);

      expect(services.requestCommand({ projectId: "project_a", type: "steer" })).toEqual({
        ok: false,
        error: { code: "missing_scope", message: "steer requires a session" },
      });
    } finally {
      database.close();
    }
  });
});

function createSeededMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);
  database.query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)").run("project_a", "project-a", "Project A");
  database
    .query("INSERT INTO tasks (id, project_id, display_id, title, status) VALUES (?, ?, ?, ?, ?)")
    .run("task_queued", "project_a", 1, "Queued", "queued");
  database
    .query("INSERT INTO tasks (id, project_id, display_id, title, status) VALUES (?, ?, ?, ?, ?)")
    .run("task_running", "project_a", 2, "Running", "running");
  database
    .query("INSERT INTO tasks (id, project_id, display_id, title, status) VALUES (?, ?, ?, ?, ?)")
    .run("task_failed", "project_a", 3, "Failed", "failed");
  database
    .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
    .run("session_running", "project_a", "task_running", 1, "running");
  database
    .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
    .run("session_failed", "project_a", "task_failed", 1, "failed");

  return database;
}

function countRows(database: Database, table: string): number {
  const row = database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}
