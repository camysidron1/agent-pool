import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { BRIDGE_SESSION_CALLBACK_SCHEMA_MIGRATION_ID, createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("canonical backend state acceptance", () => {
  test("empty DB migrates to latest schema and exposes core tables", () => {
    const database = new Database(":memory:", { strict: true });

    try {
      const result = migrateWebSandboxDatabase(database);
      const tables = database
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all()
        .map((row) => row.name);

      expect(result.applied.at(-1)?.id).toBe(BRIDGE_SESSION_CALLBACK_SCHEMA_MIGRATION_ID);
      expect(tables).toEqual([
        "artifacts",
        "chat_messages",
        "events",
        "log_streams",
        "notes",
        "orchestrator_commands",
        "outbox",
        "projects",
        "session_snapshots",
        "sessions",
        "steering_messages",
        "storage_objects",
        "task_dependencies",
        "tasks",
        "web_sandbox_migrations",
      ]);
    } finally {
      database.close();
    }
  });

  test("service flow creates project/task/session/event/outbox records transactionally", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_acceptance", slug: "acceptance", name: "Acceptance" });
      const taskResult = services.createTask({ id: "task_acceptance", projectId: "project_acceptance", title: "Build" });
      const sessionResult = services.createSessionAttempt({
        id: "session_acceptance",
        projectId: "project_acceptance",
        taskId: "task_acceptance",
      });

      expect(taskResult.task.displayId).toBe(1);
      expect(sessionResult.session.attemptNumber).toBe(1);
      expect(countRows(database, "projects")).toBe(1);
      expect(countRows(database, "tasks")).toBe(1);
      expect(countRows(database, "sessions")).toBe(1);
      expect(countRows(database, "events")).toBe(2);
      expect(countRows(database, "outbox")).toBe(2);
    } finally {
      database.close();
    }
  });

  test("invalid command state transitions return structured errors", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_acceptance", slug: "acceptance", name: "Acceptance" });
      services.createTask({ id: "task_acceptance", projectId: "project_acceptance", title: "Build" });

      expect(services.requestCommand({ projectId: "project_acceptance", taskId: "task_acceptance", type: "retry" })).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "retry requires terminal task; got queued" },
      });
    } finally {
      database.close();
    }
  });

  test("retry creates immutable session attempts", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_acceptance", slug: "acceptance", name: "Acceptance" });
      services.createTask({ id: "task_acceptance", projectId: "project_acceptance", title: "Build" });
      services.createSessionAttempt({
        id: "session_attempt_1",
        projectId: "project_acceptance",
        taskId: "task_acceptance",
        status: "failed",
      });
      services.createSessionAttempt({
        id: "session_attempt_2",
        projectId: "project_acceptance",
        taskId: "task_acceptance",
      });

      expect(
        database
          .query<{ id: string; attempt_number: number }, []>(
            "SELECT id, attempt_number FROM sessions WHERE task_id = 'task_acceptance' ORDER BY attempt_number",
          )
          .all(),
      ).toEqual([
        { id: "session_attempt_1", attempt_number: 1 },
        { id: "session_attempt_2", attempt_number: 2 },
      ]);
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
