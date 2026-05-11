import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  chatMessageRoleValues,
  chatMessages,
  migrateWebSandboxDatabase,
  notes,
  steeringMessageStatusValues,
  steeringMessages,
  type NewChatMessageRow,
  type NewNoteRow,
  type NewSteeringMessageRow,
} from "../src";

describe("chat, steering, and notes schema", () => {
  test("exports chat, steering, and note schema", () => {
    expect(chatMessages).toBeDefined();
    expect(steeringMessages).toBeDefined();
    expect(notes).toBeDefined();
    expect(chatMessageRoleValues).toEqual(["operator", "assistant", "system"]);
    expect(steeringMessageStatusValues).toEqual(["queued", "delivered", "failed", "canceled"]);

    const chat: NewChatMessageRow = {
      id: "chat_1",
      projectId: "project_a",
      role: "operator",
      body: "hello",
    };
    const steering: NewSteeringMessageRow = {
      id: "steer_1",
      projectId: "project_a",
      body: "please adjust",
    };
    const note: NewNoteRow = {
      id: "note_1",
      projectId: "project_a",
      body: "remember this",
    };

    expect(chat.metadataJson).toBeUndefined();
    expect(steering.status).toBeUndefined();
    expect(note.authorId).toBeUndefined();
  });

  test("stores project/task/session scoped chat and operator notes", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO chat_messages (id, project_id, task_id, session_id, role, body) VALUES (?, ?, ?, ?, ?, ?)")
        .run("chat_1", "project_a", "task_a_1", "session_1", "operator", "Ship it");
      database
        .query("INSERT INTO notes (id, project_id, task_id, session_id, author_id, body) VALUES (?, ?, ?, ?, ?, ?)")
        .run("note_1", "project_a", "task_a_1", "session_1", "operator-test", "Important context");

      expect(
        database.query<{ body: string }, []>("SELECT body FROM chat_messages WHERE id = 'chat_1'").get(),
      ).toEqual({ body: "Ship it" });
      expect(database.query<{ body: string }, []>("SELECT body FROM notes WHERE id = 'note_1'").get()).toEqual({
        body: "Important context",
      });
      expect(() =>
        database
          .query("INSERT INTO chat_messages (id, project_id, task_id, role, body) VALUES (?, ?, ?, ?, ?)")
          .run("chat_cross_project", "project_b", "task_a_1", "operator", "bad"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("stores steering messages with queued and failed delivery state", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO orchestrator_commands (id, project_id, task_id, session_id, type) VALUES (?, ?, ?, ?, ?)")
        .run("command_1", "project_a", "task_a_1", "session_1", "steer");
      database
        .query("INSERT INTO steering_messages (id, project_id, task_id, session_id, command_id, body) VALUES (?, ?, ?, ?, ?, ?)")
        .run("steer_queued", "project_a", "task_a_1", "session_1", "command_1", "Focus on tests");
      database
        .query(
          "INSERT INTO steering_messages (id, project_id, task_id, session_id, body, status, error_message) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("steer_failed", "project_a", "task_a_1", "session_1", "Try again", "failed", "bridge offline");

      const rows = database
        .query<{ id: string; status: string }, []>(
          "SELECT id, status FROM steering_messages WHERE project_id = 'project_a' ORDER BY id",
        )
        .all();

      expect(rows).toEqual([
        { id: "steer_failed", status: "failed" },
        { id: "steer_queued", status: "queued" },
      ]);
      expect(() =>
        database
          .query("INSERT INTO steering_messages (id, project_id, session_id, body) VALUES (?, ?, ?, ?)")
          .run("steer_cross_project", "project_b", "session_1", "bad"),
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
