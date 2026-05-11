import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  logStreamKindValues,
  logStreams,
  migrateWebSandboxDatabase,
  storageObjectKindValues,
  storageObjects,
  type NewLogStreamRow,
  type NewStorageObjectRow,
} from "../src";

describe("storage and log metadata schema", () => {
  test("exports storage object and log stream metadata schema", () => {
    expect(storageObjects).toBeDefined();
    expect(logStreams).toBeDefined();
    expect(storageObjectKindValues).toEqual(["artifact", "log", "blob"]);
    expect(logStreamKindValues).toEqual(["stdout", "stderr", "combined", "system"]);

    const object: NewStorageObjectRow = {
      id: "object_1",
      projectId: "project_a",
      kind: "artifact",
      objectKey: "artifacts/object_1",
    };
    const stream: NewLogStreamRow = {
      id: "log_1",
      projectId: "project_a",
    };

    expect(object.provider).toBeUndefined();
    expect(stream.kind).toBeUndefined();
  });

  test("stores storage object metadata for local/blob artifacts and logs", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query(
          "INSERT INTO storage_objects (id, project_id, artifact_id, kind, provider, bucket, object_key, content_type, size_bytes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("object_artifact", "project_a", "artifact_1", "artifact", "local", "web", "artifact-1.md", "text/markdown", 100);
      database
        .query("INSERT INTO storage_objects (id, project_id, kind, provider, object_key) VALUES (?, ?, ?, ?, ?)")
        .run("object_log", "project_a", "log", "local", "logs/session_1.log");

      const rows = database
        .query<{ id: string; kind: string }, []>("SELECT id, kind FROM storage_objects ORDER BY id")
        .all();

      expect(rows).toEqual([
        { id: "object_artifact", kind: "artifact" },
        { id: "object_log", kind: "log" },
      ]);
      expect(() =>
        database
          .query("INSERT INTO storage_objects (id, project_id, artifact_id, kind, object_key) VALUES (?, ?, ?, ?, ?)")
          .run("object_cross_project", "project_b", "artifact_1", "artifact", "bad"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("stores log stream metadata for session bridge callbacks", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO storage_objects (id, project_id, kind, provider, object_key) VALUES (?, ?, ?, ?, ?)")
        .run("object_log", "project_a", "log", "local", "logs/session_1.log");
      database
        .query(
          "INSERT INTO log_streams (id, project_id, task_id, session_id, storage_object_id, kind, byte_offset, line_count) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        )
        .run("stream_1", "project_a", "task_a_1", "session_1", "object_log", "combined", 128, 10);

      expect(
        database
          .query<{ byte_offset: number; line_count: number }, []>(
            "SELECT byte_offset, line_count FROM log_streams WHERE id = 'stream_1'",
          )
          .get(),
      ).toEqual({ byte_offset: 128, line_count: 10 });
      expect(() =>
        database
          .query("INSERT INTO log_streams (id, project_id, session_id) VALUES (?, ?, ?)")
          .run("stream_cross_project", "project_b", "session_1"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO log_streams (id, project_id, kind) VALUES (?, ?, ?)")
          .run("stream_bad_kind", "project_a", "debug"),
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
  database
    .query("INSERT INTO artifacts (id, project_id, task_id, session_id, kind, uri) VALUES (?, ?, ?, ?, ?, ?)")
    .run("artifact_1", "project_a", "task_a_1", "session_1", "document", "agent-docs/output.md");

  return database;
}
