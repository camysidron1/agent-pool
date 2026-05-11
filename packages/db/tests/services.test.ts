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
