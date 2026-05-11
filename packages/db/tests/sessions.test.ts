import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  migrateWebSandboxDatabase,
  sessionSnapshots,
  sessions,
  type NewSessionRow,
  type NewSessionSnapshotRow,
} from "../src";

describe("session schema", () => {
  test("exports Drizzle schema for sessions and session snapshots", () => {
    expect(sessions).toBeDefined();
    expect(sessionSnapshots).toBeDefined();

    const session: NewSessionRow = {
      id: "session_1",
      projectId: "project_1",
      taskId: "task_1",
      attemptNumber: 1,
    };
    const snapshot: NewSessionSnapshotRow = {
      id: "snapshot_1",
      projectId: "project_1",
      sessionId: "session_1",
    };

    expect(session.status).toBeUndefined();
    expect(snapshot.kind).toBeUndefined();
  });

  test("links sessions to tasks/projects and preserves immutable retry attempts", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
        .run("session_1", "project_a", "task_a_1", 1, "failed");
      database
        .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
        .run("session_2", "project_a", "task_a_1", 2, "queued");

      const attempts = database
        .query<{ attempt_number: number; id: string }, []>(
          "SELECT attempt_number, id FROM sessions WHERE project_id = 'project_a' AND task_id = 'task_a_1' ORDER BY attempt_number",
        )
        .all();

      expect(attempts).toEqual([
        { attempt_number: 1, id: "session_1" },
        { attempt_number: 2, id: "session_2" },
      ]);
      expect(() =>
        database
          .query("INSERT INTO sessions (id, project_id, task_id, attempt_number) VALUES (?, ?, ?, ?)")
          .run("session_duplicate", "project_a", "task_a_1", 2),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO sessions (id, project_id, task_id, attempt_number) VALUES (?, ?, ?, ?)")
          .run("session_cross_project", "project_b", "task_a_1", 1),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("stores session snapshot metadata without provider behavior", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
        .run("session_1", "project_a", "task_a_1", 1, "running");
      database
        .query(
          "INSERT INTO session_snapshots (id, project_id, session_id, kind, provider_snapshot_id, label, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("snapshot_1", "project_a", "session_1", "manual", "provider-snapshot-1", "before retry", "{\"ok\":true}");

      const snapshot = database
        .query<{ kind: string; metadata_json: string; provider_snapshot_id: string }, []>(
          "SELECT kind, metadata_json, provider_snapshot_id FROM session_snapshots WHERE id = 'snapshot_1'",
        )
        .get();

      expect(snapshot).toEqual({
        kind: "manual",
        metadata_json: '{"ok":true}',
        provider_snapshot_id: "provider-snapshot-1",
      });
      expect(() =>
        database
          .query("INSERT INTO session_snapshots (id, project_id, session_id) VALUES (?, ?, ?)")
          .run("snapshot_missing_session", "project_a", "missing_session"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO session_snapshots (id, project_id, session_id) VALUES (?, ?, ?)")
          .run("snapshot_cross_project", "project_b", "session_1"),
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

  return database;
}
