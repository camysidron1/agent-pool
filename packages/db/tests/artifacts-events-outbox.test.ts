import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  artifactKindValues,
  artifacts,
  createCanonicalStateServices,
  events,
  migrateWebSandboxDatabase,
  outbox,
  outboxStatusValues,
  type NewArtifactRow,
  type NewEventRow,
  type NewOutboxRow,
} from "../src";

describe("artifact, event, and outbox schema", () => {
  test("exports artifact, event, and outbox schema", () => {
    expect(artifacts).toBeDefined();
    expect(events).toBeDefined();
    expect(outbox).toBeDefined();
    expect(artifactKindValues).toContain("final_response_url");
    expect(artifactKindValues).toContain("document");
    expect(outboxStatusValues).toEqual(["queued", "published", "failed"]);

    const artifact: NewArtifactRow = {
      id: "artifact_1",
      projectId: "project_a",
      kind: "document",
      uri: "agent-docs/result.md",
    };
    const event: NewEventRow = {
      id: "event_1",
      projectId: "project_a",
      type: "task.created",
    };
    const outboxRow: NewOutboxRow = {
      id: "outbox_1",
      projectId: "project_a",
      routingKey: "project.project_a.events",
    };

    expect(artifact.metadataJson).toBeUndefined();
    expect(event.payloadJson).toBeUndefined();
    expect(outboxRow.status).toBeUndefined();
  });

  test("stores final response URL and document artifacts scoped to task/session", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO artifacts (id, project_id, task_id, session_id, kind, uri, title) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("artifact_url", "project_a", "task_a_1", "session_1", "final_response_url", "https://example.test", "Preview");
      database
        .query("INSERT INTO artifacts (id, project_id, task_id, kind, uri) VALUES (?, ?, ?, ?, ?)")
        .run("artifact_doc", "project_a", "task_a_1", "document", "agent-docs/output.md");

      const rows = database
        .query<{ id: string; kind: string }, []>("SELECT id, kind FROM artifacts WHERE project_id = 'project_a' ORDER BY id")
        .all();

      expect(rows).toEqual([
        { id: "artifact_doc", kind: "document" },
        { id: "artifact_url", kind: "final_response_url" },
      ]);
      expect(() =>
        database
          .query("INSERT INTO artifacts (id, project_id, task_id, kind, uri) VALUES (?, ?, ?, ?, ?)")
          .run("artifact_cross_project", "project_b", "task_a_1", "document", "agent-docs/bad.md"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("records bridge document artifacts only from allowed document roots", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      database
        .query("UPDATE sessions SET status = 'running' WHERE id = 'session_1'")
        .run();

      const result = services.recordDocumentArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_1",
        path: "agent-docs/result.md",
        title: "result.md",
        contentType: "text/markdown",
        sizeBytes: 100,
      });
      const duplicate = services.recordDocumentArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_1",
        path: "agent-docs/result.md",
      });
      const rejected = services.recordDocumentArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_1",
        path: "docs/result.md",
      });

      expect(result).toMatchObject({
        ok: true,
        idempotent: false,
        artifact: { kind: "document", uri: "agent-docs/result.md", title: "result.md" },
        event: { type: "artifact.document.registered" },
        outbox: { routingKey: "project.project_a.events" },
      });
      expect(duplicate).toMatchObject({
        ok: true,
        idempotent: true,
        artifact: { uri: "agent-docs/result.md" },
        event: { type: "artifact.document.idempotent" },
      });
      expect(rejected).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "document path is outside allowed bridge roots: docs/result.md" },
      });
      expect(
        database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'document' AND uri = 'agent-docs/result.md'")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test("records smoke evidence as idempotent task/session file artifacts", () => {
    const database = createSeededMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const result = services.recordSmokeEvidenceArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_1",
        uri: "storage://bucket/projects/project_a/tasks/task_a_1/evidence/pass.json",
        title: "E2B smoke evidence pass",
        metadata: {
          source: "smoke:e2b",
          validationStatus: "pass",
          evidenceStatus: "pass",
        },
      });
      const duplicate = services.recordSmokeEvidenceArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_1",
        uri: "storage://bucket/projects/project_a/tasks/task_a_1/evidence/pass.json",
        title: "E2B smoke evidence pass",
        metadata: {
          source: "smoke:e2b",
          validationStatus: "pass",
          evidenceStatus: "pass",
        },
      });
      const missingSession = services.recordSmokeEvidenceArtifact({
        projectId: "project_a",
        taskId: "task_a_1",
        sessionId: "session_missing",
        uri: "storage://bucket/projects/project_a/tasks/task_a_1/evidence/missing.json",
        title: "missing",
        metadata: {},
      });

      expect(result).toMatchObject({
        ok: true,
        idempotent: false,
        artifact: { kind: "file", uri: "storage://bucket/projects/project_a/tasks/task_a_1/evidence/pass.json" },
        event: { type: "artifact.smoke_evidence.registered" },
        outbox: { routingKey: "project.project_a.events" },
      });
      expect(duplicate).toMatchObject({
        ok: true,
        idempotent: true,
        event: { type: "artifact.smoke_evidence.idempotent" },
      });
      expect(missingSession).toEqual({
        ok: false,
        error: { code: "not_found", message: "session not found: session_missing" },
      });
      expect(
        database
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM artifacts WHERE kind = 'file' AND uri LIKE 'storage://bucket/%'")
          .get()?.count,
      ).toBe(1);
    } finally {
      database.close();
    }
  });

  test("stores append-only events and outbox records without per-session queues", () => {
    const database = createSeededMemoryDatabase();

    try {
      database
        .query("INSERT INTO orchestrator_commands (id, project_id, task_id, session_id, type) VALUES (?, ?, ?, ?, ?)")
        .run("command_1", "project_a", "task_a_1", "session_1", "stop");
      database
        .query("INSERT INTO events (id, project_id, task_id, session_id, command_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run("event_1", "project_a", "task_a_1", "session_1", "command_1", "command.queued", '{"type":"stop"}');
      database
        .query("INSERT INTO outbox (id, project_id, event_id, routing_key, payload_json) VALUES (?, ?, ?, ?, ?)")
        .run("outbox_1", "project_a", "event_1", "project.project_a.control", '{"eventId":"event_1"}');

      const outboxRow = database
        .query<{ routing_key: string; status: string }, []>("SELECT routing_key, status FROM outbox WHERE id = 'outbox_1'")
        .get();

      expect(outboxRow).toEqual({ routing_key: "project.project_a.control", status: "queued" });
      expect(outboxRow?.routing_key).not.toContain("session_1");
      expect(() =>
        database
          .query("INSERT INTO events (id, project_id, task_id, type) VALUES (?, ?, ?, ?)")
          .run("event_cross_project", "project_b", "task_a_1", "task.updated"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO outbox (id, project_id, event_id, routing_key) VALUES (?, ?, ?, ?)")
          .run("outbox_cross_project", "project_b", "event_1", "project.project_b.events"),
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
