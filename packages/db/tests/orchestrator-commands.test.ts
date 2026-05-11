import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  migrateWebSandboxDatabase,
  orchestratorCommandStatusValues,
  orchestratorCommandTypeValues,
  orchestratorCommands,
  type NewOrchestratorCommandRow,
} from "../src";

describe("orchestrator command schema", () => {
  test("exports durable command schema and enums", () => {
    expect(orchestratorCommands).toBeDefined();
    expect(orchestratorCommandTypeValues).toEqual(["start", "stop", "cancel", "retry", "cleanup", "interrupt", "steer"]);
    expect(orchestratorCommandStatusValues).toEqual(["queued", "running", "succeeded", "failed", "canceled"]);

    const command: NewOrchestratorCommandRow = {
      id: "command_1",
      projectId: "project_a",
      type: "start",
    };

    expect(command.status).toBeUndefined();
  });

  test("stores project, task, and session scoped command rows", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query(
          "INSERT INTO orchestrator_commands (id, project_id, type, payload_json, requested_by) VALUES (?, ?, ?, ?, ?)",
        )
        .run("command_project", "project_a", "cleanup", "{}", "operator-test");
      database
        .query("INSERT INTO orchestrator_commands (id, project_id, task_id, type, payload_json) VALUES (?, ?, ?, ?, ?)")
        .run("command_task", "project_a", "task_a_1", "retry", '{"reason":"test"}');
      database
        .query(
          "INSERT INTO orchestrator_commands (id, project_id, task_id, session_id, type, status) VALUES (?, ?, ?, ?, ?, ?)",
        )
        .run("command_session", "project_a", "task_a_1", "session_1", "interrupt", "running");

      const rows = database
        .query<{ id: string; status: string; type: string }, []>(
          "SELECT id, status, type FROM orchestrator_commands WHERE project_id = 'project_a' ORDER BY id",
        )
        .all();

      expect(rows).toEqual([
        { id: "command_project", status: "queued", type: "cleanup" },
        { id: "command_session", status: "running", type: "interrupt" },
        { id: "command_task", status: "queued", type: "retry" },
      ]);
    } finally {
      database.close();
    }
  });

  test("enforces command state values and project ownership constraints", () => {
    const database = createSeededMemoryDatabase();

    try {
      expect(() =>
        database
          .query("INSERT INTO orchestrator_commands (id, project_id, type) VALUES (?, ?, ?)")
          .run("bad_type", "project_a", "pause"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO orchestrator_commands (id, project_id, type, status) VALUES (?, ?, ?, ?)")
          .run("bad_status", "project_a", "stop", "waiting"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO orchestrator_commands (id, project_id, task_id, type) VALUES (?, ?, ?, ?)")
          .run("cross_project_task", "project_b", "task_a_1", "cancel"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO orchestrator_commands (id, project_id, session_id, type) VALUES (?, ?, ?, ?)")
          .run("cross_project_session", "project_b", "session_1", "interrupt"),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});

function createSeededMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);
  database.query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)").run("project_a", "project-a", "Project A");
  database.query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)").run("project_b", "project-b", "Project B");
  database
    .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
    .run("task_a_1", "project_a", 1, "Task A1");
  database
    .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
    .run("task_b_1", "project_b", 1, "Task B1");
  database
    .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
    .run("session_1", "project_a", "task_a_1", 1, "running");
  database
    .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
    .run("session_b_1", "project_b", "task_b_1", 1, "running");

  return database;
}
