import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("final assistant response persistence", () => {
  test("records final assistant response fields and appends an event", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const result = services.recordFinalAssistantResponse({
        projectId: "project_a",
        sessionId: "session_1",
        text: "Preview: https://example.test",
        metadata: { model: "test-model" },
      });

      expect(result.ok).toBe(true);
      const session = database
        .query<{ final_response_text: string; final_response_metadata_json: string; final_response_recorded_at: string }, []>(
          "SELECT final_response_text, final_response_metadata_json, final_response_recorded_at FROM sessions WHERE id = 'session_1'",
        )
        .get();

      expect(session?.final_response_text).toBe("Preview: https://example.test");
      expect(session?.final_response_metadata_json).toBe('{"model":"test-model"}');
      expect(session?.final_response_recorded_at).toBeString();
      expect(database.query<{ type: string }, []>("SELECT type FROM events WHERE session_id = 'session_1'").get()).toEqual({
        type: "session.final_response.recorded",
      });
      expect(
        database
          .query<{ kind: string; uri: string; title: string | null }, []>(
            "SELECT kind, uri, title FROM artifacts WHERE session_id = 'session_1'",
          )
          .get(),
      ).toEqual({
        kind: "final_response_url",
        uri: "https://example.test",
        title: "Final response URL",
      });
    } finally {
      database.close();
    }
  });

  test("allows identical idempotent final response writes and rejects conflicting writes", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const first = services.recordFinalAssistantResponse({ projectId: "project_a", sessionId: "session_1", text: "done" });
      const second = services.recordFinalAssistantResponse({ projectId: "project_a", sessionId: "session_1", text: "done" });
      const conflict = services.recordFinalAssistantResponse({ projectId: "project_a", sessionId: "session_1", text: "different" });

      expect(first.ok).toBe(true);
      expect(second.ok).toBe(true);
      expect(conflict).toEqual({
        ok: false,
        error: { code: "conflict", message: "final assistant response already recorded with different content" },
      });
    } finally {
      database.close();
    }
  });

  test("returns structured not found errors", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);

      expect(services.recordFinalAssistantResponse({ projectId: "project_a", sessionId: "missing", text: "done" })).toEqual({
        ok: false,
        error: { code: "not_found", message: "session not found: missing" },
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
    .run("task_1", "project_a", 1, "Task", "running");
  database
    .query("INSERT INTO sessions (id, project_id, task_id, attempt_number, status) VALUES (?, ?, ?, ?, ?)")
    .run("session_1", "project_a", "task_1", 1, "running");

  return database;
}
