import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("canonical state services", () => {
  test("creates projects and project-scoped tasks transactionally with event/outbox rows", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const project = services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      const first = services.createTask({ id: "task_1", projectId: project.id, title: "First" });
      const second = services.createTask({ id: "task_2", projectId: project.id, title: "Second" });

      expect(first.task.displayId).toBe(1);
      expect(second.task.displayId).toBe(2);
      expect(first.event.type).toBe("task.created");
      expect(first.outbox.routingKey).toBe("project.project_a.events");
      expect(countRows(database, "tasks")).toBe(2);
      expect(countRows(database, "events")).toBe(2);
      expect(countRows(database, "outbox")).toBe(2);
    } finally {
      database.close();
    }
  });

  test("rolls back task/event/outbox writes when a task transaction fails", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });

      expect(() => services.createTask({ id: "task_1", projectId: "project_a", title: "Duplicate id" })).toThrow();

      expect(countRows(database, "tasks")).toBe(1);
      expect(countRows(database, "events")).toBe(1);
      expect(countRows(database, "outbox")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("creates immutable session attempts with event/outbox rows", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });

      const first = services.createSessionAttempt({ id: "session_1", projectId: "project_a", taskId: "task_1", status: "failed" });
      const retry = services.createSessionAttempt({ id: "session_2", projectId: "project_a", taskId: "task_1" });

      expect(first.session.attemptNumber).toBe(1);
      expect(retry.session.attemptNumber).toBe(2);
      expect(retry.outbox.routingKey).toBe("project.project_a.control");
      expect(
        database
          .query<{ attempt_number: number; id: string }, []>(
            "SELECT attempt_number, id FROM sessions WHERE task_id = 'task_1' ORDER BY attempt_number",
          )
          .all(),
      ).toEqual([
        { attempt_number: 1, id: "session_1" },
        { attempt_number: 2, id: "session_2" },
      ]);
    } finally {
      database.close();
    }
  });

  test("claims the highest-priority eligible queued task atomically with a starting session", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });
      services.createTask({ id: "task_2", projectId: "project_a", title: "Second" });

      const claim = services.claimNextTask({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "test-provider" });

      expect(claim).toMatchObject({
        ok: true,
        task: { id: "task_1", projectId: "project_a", displayId: 1, status: "running" },
        session: {
          id: "session_1",
          projectId: "project_a",
          taskId: "task_1",
          attemptNumber: 1,
          status: "starting",
          runtimeProvider: "test-provider",
        },
        event: { projectId: "project_a", type: "task.claimed" },
        outbox: { projectId: "project_a", routingKey: "project.project_a.control" },
      });
      expect(database.query<{ status: string }, []>("SELECT status FROM tasks WHERE id = 'task_1'").get()).toEqual({
        status: "running",
      });
      expect(database.query<{ status: string; runtime_provider: string | null }, []>("SELECT status, runtime_provider FROM sessions WHERE id = 'session_1'").get()).toEqual({
        status: "starting",
        runtime_provider: "test-provider",
      });
    } finally {
      database.close();
    }
  });

  test("skips tasks with unmet dependencies and reports no work after active task claims", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "dependency", projectId: "project_a", title: "Dependency" });
      services.createTask({ id: "blocked", projectId: "project_a", title: "Blocked" });
      database
        .query("INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES ('project_a', 'blocked', 'dependency')")
        .run();

      const firstClaim = services.claimNextTask({ projectId: "project_a", sessionId: "session_dependency" });
      const secondClaim = services.claimNextTask({ projectId: "project_a", sessionId: "session_duplicate" });
      database.query("UPDATE tasks SET status = 'completed' WHERE id = 'dependency'").run();
      database.query("UPDATE sessions SET status = 'succeeded' WHERE id = 'session_dependency'").run();
      const unblockedClaim = services.claimNextTask({ projectId: "project_a", sessionId: "session_blocked" });
      const noWork = services.claimNextTask({ projectId: "project_a", sessionId: "session_none" });

      expect(firstClaim).toMatchObject({ ok: true, task: { id: "dependency" } });
      expect(secondClaim).toEqual({ ok: false, reason: "no_eligible_task" });
      expect(unblockedClaim).toMatchObject({ ok: true, task: { id: "blocked" } });
      expect(noWork).toEqual({ ok: false, reason: "no_eligible_task" });
      expect(countRows(database, "sessions")).toBe(2);
      expect(
        database.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions WHERE task_id = 'blocked' AND status IN ('queued', 'starting', 'running')").get()
          ?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test("reports startup success idempotently for claimed sessions", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });
      const claim = services.claimNextTask({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "test-provider" });
      expect(claim).toMatchObject({ ok: true, session: { status: "starting" } });

      const started = services.reportStartupSucceeded({
        projectId: "project_a",
        sessionId: "session_1",
        runtimeSessionId: "runtime_session_1",
      });
      const duplicate = services.reportStartupSucceeded({
        projectId: "project_a",
        sessionId: "session_1",
        runtimeSessionId: "runtime_session_1",
      });

      expect(started).toMatchObject({
        ok: true,
        idempotent: false,
        session: { id: "session_1", status: "running", runtimeSessionId: "runtime_session_1" },
        task: { id: "task_1", status: "running" },
        event: { type: "session.startup_succeeded" },
        outbox: { routingKey: "project.project_a.control" },
      });
      expect(duplicate).toMatchObject({
        ok: true,
        idempotent: true,
        session: { id: "session_1", status: "running", runtimeSessionId: "runtime_session_1" },
      });
      expect(database.query<{ status: string; runtime_session_id: string | null }, []>("SELECT status, runtime_session_id FROM sessions WHERE id = 'session_1'").get()).toEqual({
        status: "running",
        runtime_session_id: "runtime_session_1",
      });
    } finally {
      database.close();
    }
  });

  test("reports startup failure by failing the session and blocking the task with an event reason", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });
      const claim = services.claimNextTask({ projectId: "project_a", sessionId: "session_1" });
      expect(claim).toMatchObject({ ok: true, session: { status: "starting" } });

      const failed = services.reportStartupFailed({
        projectId: "project_a",
        sessionId: "session_1",
        errorMessage: "runtime boot timed out",
      });
      const duplicate = services.reportStartupFailed({
        projectId: "project_a",
        sessionId: "session_1",
        errorMessage: "runtime boot timed out",
      });
      const conflictingDuplicate = services.reportStartupFailed({
        projectId: "project_a",
        sessionId: "session_1",
        errorMessage: "different reason",
      });

      expect(failed).toMatchObject({
        ok: true,
        idempotent: false,
        session: { id: "session_1", status: "failed" },
        task: { id: "task_1", status: "blocked" },
        event: { type: "session.startup_failed" },
        outbox: { routingKey: "project.project_a.control" },
      });
      expect(duplicate).toMatchObject({ ok: true, idempotent: true, session: { id: "session_1", status: "failed" } });
      expect(conflictingDuplicate).toEqual({
        ok: false,
        error: { code: "conflict", message: "session session_1 already failed with different startup details" },
      });
      expect(database.query<{ status: string }, []>("SELECT status FROM tasks WHERE id = 'task_1'").get()).toEqual({
        status: "blocked",
      });
      expect(JSON.parse(database.query<{ payload_json: string }, []>("SELECT payload_json FROM events WHERE type = 'session.startup_failed'").get()?.payload_json ?? "{}")).toMatchObject({
        errorMessage: "runtime boot timed out",
      });
    } finally {
      database.close();
    }
  });

  test("rejects unsafe startup report transitions", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_queued", projectId: "project_a", title: "Queued" });
      services.createTask({ id: "task_starting", projectId: "project_a", title: "Starting" });
      services.createSessionAttempt({ id: "session_queued", projectId: "project_a", taskId: "task_queued" });

      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "missing" })).toEqual({
        ok: false,
        error: { code: "not_found", message: "session not found: missing" },
      });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_queued" })).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "startup success requires starting session; got queued" },
      });

      const claim = services.claimNextTask({ projectId: "project_a", sessionId: "session_starting" });
      expect(claim).toMatchObject({ ok: true });
      services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_starting", runtimeSessionId: "runtime_1" });
      expect(services.reportStartupFailed({ projectId: "project_a", sessionId: "session_starting", errorMessage: "too late" })).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "startup failure requires starting session; got running" },
      });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_starting", runtimeSessionId: "runtime_2" })).toEqual({
        ok: false,
        error: { code: "conflict", message: "session session_starting already has a different runtime session id" },
      });
    } finally {
      database.close();
    }
  });

  test("records session heartbeats and clears stale markers", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_1" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_1" })).toMatchObject({ ok: true });
      database
        .query(
          "UPDATE sessions SET heartbeat_status = 'stale', last_heartbeat_at = '2026-01-01T00:00:30.000Z', stale_at = '2026-01-01T00:01:00.000Z' WHERE id = 'session_1'",
        )
        .run();

      const heartbeat = services.reportSessionHeartbeat({
        projectId: "project_a",
        sessionId: "session_1",
        observedAt: "2026-01-01T00:02:00.000Z",
      });

      expect(heartbeat).toMatchObject({
        ok: true,
        session: {
          id: "session_1",
          status: "running",
          heartbeatStatus: "fresh",
          lastHeartbeatAt: "2026-01-01T00:02:00.000Z",
          staleAt: null,
          lostAt: null,
        },
        event: { type: "session.heartbeat" },
        outbox: { routingKey: "project.project_a.events" },
      });
      expect(
        database
          .query<
            { last_heartbeat_at: string | null; heartbeat_status: string; stale_at: string | null; lost_at: string | null },
            []
          >("SELECT last_heartbeat_at, heartbeat_status, stale_at, lost_at FROM sessions WHERE id = 'session_1'")
          .get(),
      ).toEqual({
        last_heartbeat_at: "2026-01-01T00:02:00.000Z",
        heartbeat_status: "fresh",
        stale_at: null,
        lost_at: null,
      });
    } finally {
      database.close();
    }
  });

  test("reconciles stale and lost sessions deterministically without provider calls", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_stale", projectId: "project_a", title: "Stale" });
      services.createTask({ id: "task_lost", projectId: "project_a", title: "Lost" });
      services.createTask({ id: "task_fresh", projectId: "project_a", title: "Fresh" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_stale" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_stale" })).toMatchObject({ ok: true });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_lost" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_lost" })).toMatchObject({ ok: true });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_fresh" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_fresh" })).toMatchObject({ ok: true });
      database
        .query(
          `
            UPDATE sessions
            SET last_heartbeat_at = CASE id
              WHEN 'session_lost' THEN '2026-01-01T00:00:00.000Z'
              WHEN 'session_stale' THEN '2026-01-01T00:00:30.000Z'
              ELSE '2026-01-01T00:01:30.000Z'
            END
          `,
        )
        .run();

      const result = services.reconcileLostSessions({
        projectId: "project_a",
        lostBefore: "2026-01-01T00:00:00.000Z",
        staleBefore: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:02:00.000Z",
      });
      const repeated = services.reconcileLostSessions({
        projectId: "project_a",
        lostBefore: "2026-01-01T00:00:00.000Z",
        staleBefore: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:03:00.000Z",
      });

      expect(result.stale).toEqual([
        {
          id: "session_stale",
          projectId: "project_a",
          taskId: "task_stale",
          status: "running",
          heartbeatStatus: "stale",
          lastHeartbeatAt: "2026-01-01T00:00:30.000Z",
          heartbeatBasisAt: "2026-01-01T00:00:30.000Z",
        },
      ]);
      expect(result.lost).toEqual([
        {
          id: "session_lost",
          projectId: "project_a",
          taskId: "task_lost",
          status: "failed",
          heartbeatStatus: "lost",
          lastHeartbeatAt: "2026-01-01T00:00:00.000Z",
          heartbeatBasisAt: "2026-01-01T00:00:00.000Z",
        },
      ]);
      expect(result.events.map((event) => event.type).sort()).toEqual(["session.lost", "session.stale"]);
      expect(result.outbox).toHaveLength(2);
      expect(repeated.stale).toEqual([]);
      expect(repeated.lost).toEqual([]);
      expect(
        database
          .query<
            { id: string; status: string; heartbeat_status: string; stale_at: string | null; lost_at: string | null },
            []
          >(
            "SELECT id, status, heartbeat_status, stale_at, lost_at FROM sessions WHERE id IN ('session_stale', 'session_lost') ORDER BY id",
          )
          .all(),
      ).toEqual([
        {
          id: "session_lost",
          status: "failed",
          heartbeat_status: "lost",
          stale_at: "2026-01-01T00:02:00.000Z",
          lost_at: "2026-01-01T00:02:00.000Z",
        },
        {
          id: "session_stale",
          status: "running",
          heartbeat_status: "stale",
          stale_at: "2026-01-01T00:02:00.000Z",
          lost_at: null,
        },
      ]);
      expect(database.query<{ status: string }, []>("SELECT status FROM tasks WHERE id = 'task_lost'").get()).toEqual({
        status: "blocked",
      });
      expect(
        database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM events WHERE type IN ('session.stale', 'session.lost')")
          .get()?.count,
      ).toBe(2);
    } finally {
      database.close();
    }
  });

  test("appends structured event payloads", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      const event = services.appendEvent({
        id: "event_custom",
        projectId: "project_a",
        type: "project.note",
        payload: { ok: true },
      });

      expect(event).toEqual({ id: "event_custom", projectId: "project_a", type: "project.note" });
      expect(database.query<{ payload_json: string }, []>("SELECT payload_json FROM events WHERE id = 'event_custom'").get()).toEqual({
        payload_json: '{"ok":true}',
      });
    } finally {
      database.close();
    }
  });
});

function createMigratedMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);
  return database;
}

function countRows(database: Database, table: string): number {
  const row = database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}
