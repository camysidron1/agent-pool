import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter } from "@agent-pool/queue";
import { createFakeRuntimeProvider, type RuntimeClock } from "@agent-pool/runtime";
import { createStorageAdapter } from "@agent-pool/storage";
import { checkBackendInternalHealth, createBackendInternalApiClient } from "../../orchestrator/src/backend-client";
import { runControlQueueConsumerOnce } from "../../orchestrator/src/control-consumer";
import { createRuntimeStarter } from "../../orchestrator/src/runtime-starter";
import { runTaskQueueConsumerOnce } from "../../orchestrator/src/task-consumer";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";
import { createOutboxPublisher } from "../src/outbox-publisher";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("control-plane smoke", () => {
  test("API migration boot, health/metrics, orchestrator internal auth client, and adapters work in deterministic config", async () => {
    const server = await startApi();

    try {
      const apiHealth = await fetch(`${server.baseUrl}/health`);
      const apiMetrics = await fetch(`${server.baseUrl}/metrics`);
      const orchestratorCheck = await checkBackendInternalHealth({
        config: server.orchestratorConfig,
      });
      const queue = createRabbitMqAdapter(server.apiConfig.rabbitmq);
      const storage = createStorageAdapter(server.apiConfig.storage);

      expect(apiHealth.status).toBe(200);
      expect(await apiHealth.json()).toMatchObject({
        ok: true,
        database: { connected: true },
        adapters: { queue: { kind: "rabbitmq" }, storage: { kind: "local" } },
      });
      expect(await apiMetrics.text()).toContain("agent_pool_api_database_applied_migrations");
      expect(orchestratorCheck).toMatchObject({ ok: true, status: 200 });
      expect(queue.connected).toBe(false);
      expect(queue.projectQueues("project_smoke")).toEqual({
        taskQueue: "project-tasks.project_smoke",
        controlQueue: "project-control.project_smoke",
      });
      expect(storage.planObject(["smoke", "artifact.txt"]).key).toBe("smoke/artifact.txt");
    } finally {
      await server.close();
    }
  });

  test("orchestrator internal API workflow covers claims, reports, heartbeat, reconcile, and no-work responses", async () => {
    const server = await startApi();

    try {
      const services = createCanonicalStateServices(server.database.sqlite);
      const client = createBackendInternalApiClient({ config: server.orchestratorConfig });
      services.createProject({ id: "project_smoke", slug: "smoke", name: "Smoke" });
      services.createTask({ id: "task_run", projectId: "project_smoke", title: "Run task" });

      const taskClaim = await client.claimNextTask({
        projectId: "project_smoke",
        sessionId: "session_run",
        runtimeProvider: "fake-provider",
      });
      const duplicateTaskClaim = await client.claimNextTask({
        projectId: "project_smoke",
        sessionId: "session_duplicate",
      });
      const startupSucceeded = await client.reportStartupSucceeded({
        projectId: "project_smoke",
        sessionId: "session_run",
        runtimeSessionId: "runtime_run",
      });

      expect(taskClaim).toMatchObject({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_run" },
          session: {
            id: "session_run",
            status: "starting",
            bridge: {
              projectId: "project_smoke",
              taskId: "task_run",
              sessionId: "session_run",
              callbackBaseUrl: server.apiConfig.bridge.callbackBaseUrl,
              sessionToken: {
                headerName: server.apiConfig.bridge.sessionTokenHeaderName,
              },
            },
          },
        },
      });
      if (taskClaim.ok && taskClaim.body.claimed) {
        expect(taskClaim.body.session.bridge.sessionToken.token).toStartWith("bridge_token_");
        expect(taskClaim.body.session.bridge.sessionToken.token).not.toBe(server.apiConfig.serviceToken.token);
      }
      expect(duplicateTaskClaim).toMatchObject({ ok: true, body: { ok: true, claimed: false, reason: "no_eligible_task" } });
      expect(startupSucceeded).toMatchObject({ ok: true, body: { ok: true, session: { id: "session_run", status: "running" } } });
      expect(
        server.database.sqlite
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sessions WHERE task_id = 'task_run' AND status IN ('queued', 'starting', 'running')",
          )
          .get()?.count,
      ).toBe(1);

      const queuedCommand = services.requestCommand({
        id: "command_steer",
        projectId: "project_smoke",
        taskId: "task_run",
        sessionId: "session_run",
        type: "steer",
        payload: { body: "continue" },
      });
      expect(queuedCommand).toMatchObject({ ok: true });

      const commandClaim = await client.claimNextCommand({ projectId: "project_smoke" });
      const duplicateCommandClaim = await client.claimNextCommand({ projectId: "project_smoke" });
      const commandStarted = await client.reportCommandStarted({ projectId: "project_smoke", commandId: "command_steer" });
      const commandSucceeded = await client.reportCommandSucceeded({ projectId: "project_smoke", commandId: "command_steer" });
      const heartbeat = await client.reportSessionHeartbeat({
        projectId: "project_smoke",
        sessionId: "session_run",
        observedAt: "2026-01-01T00:01:30.000Z",
      });

      expect(commandClaim).toMatchObject({ ok: true, body: { ok: true, claimed: true, command: { id: "command_steer", status: "running" } } });
      expect(duplicateCommandClaim).toMatchObject({ ok: true, body: { ok: true, claimed: false, reason: "no_queued_command" } });
      expect(commandStarted).toMatchObject({ ok: true, body: { ok: true, command: { id: "command_steer", status: "running" } } });
      expect(commandSucceeded).toMatchObject({ ok: true, body: { ok: true, command: { id: "command_steer", status: "succeeded" } } });
      expect(heartbeat).toMatchObject({ ok: true, body: { ok: true, session: { id: "session_run", heartbeatStatus: "fresh" } } });

      server.database.sqlite
        .query("UPDATE sessions SET last_heartbeat_at = '2026-01-01T00:00:00.000Z' WHERE id = 'session_run'")
        .run();
      const reconcile = await client.reconcile({
        projectId: "project_smoke",
        lostBefore: "2026-01-01T00:00:00.000Z",
        staleBefore: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:02:00.000Z",
      });

      expect(reconcile).toMatchObject({
        ok: true,
        body: { ok: true, stale: [], lost: [{ id: "session_run", status: "failed", heartbeatStatus: "lost" }] },
      });
      expect(
        server.database.sqlite
          .query<{ session_status: string; heartbeat_status: string; task_status: string }, []>(
            `
              SELECT s.status AS session_status, s.heartbeat_status, t.status AS task_status
              FROM sessions s
              JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
              WHERE s.id = 'session_run'
            `,
          )
          .get(),
      ).toEqual({ session_status: "failed", heartbeat_status: "lost", task_status: "blocked" });

      services.createTask({ id: "task_startup_failure", projectId: "project_smoke", title: "Startup failure task" });
      const failedTaskClaim = await client.claimNextTask({ projectId: "project_smoke", sessionId: "session_startup_failure" });
      const startupFailed = await client.reportStartupFailed({
        projectId: "project_smoke",
        sessionId: "session_startup_failure",
        errorMessage: "startup timed out",
      });

      expect(failedTaskClaim).toMatchObject({ ok: true, body: { ok: true, claimed: true, session: { id: "session_startup_failure" } } });
      expect(startupFailed).toMatchObject({
        ok: true,
        body: { ok: true, session: { id: "session_startup_failure", status: "failed" }, task: { status: "blocked" } },
      });
    } finally {
      await server.close();
    }
  });

  test("Phase 4 queue smoke publishes outbox hints and consumes duplicate task/control wakeups once", async () => {
    const server = await startApi();

    try {
      const services = createCanonicalStateServices(server.database.sqlite);
      const backend = createBackendInternalApiClient({ config: server.orchestratorConfig });
      services.createProject({ id: "project_phase4", slug: "phase-4", name: "Phase 4" });
      services.createTask({ id: "task_phase4", projectId: "project_phase4", title: "Run Phase 4 task" });
      const command = services.requestCommand({
        id: "command_phase4_cancel",
        projectId: "project_phase4",
        taskId: "task_phase4",
        type: "cancel",
      });
      expect(command).toMatchObject({ ok: true });

      const publish = createOutboxPublisher({ database: server.database, queue: server.queue }).publishQueued();
      server.queue.publishProjectTaskHint("project_phase4", { duplicate: true, taskId: "task_phase4" });
      server.queue.publishProjectControlHint("project_phase4", { duplicate: true, commandId: "command_phase4_cancel" });

      expect(publish).toMatchObject({
        scanned: 2,
        published: [
          { projectId: "project_phase4", queue: "project-tasks.project_phase4", queueKind: "task" },
          { projectId: "project_phase4", queue: "project-control.project_phase4", queueKind: "control" },
        ],
        failed: [],
      });
      expect(server.queue.publishedHints.map((hint) => hint.queue)).toEqual([
        "project-tasks.project_phase4",
        "project-control.project_phase4",
        "project-tasks.project_phase4",
        "project-control.project_phase4",
      ]);
      expect(server.queue.publishedHints.every((hint) => !hint.queue.includes("session-"))).toBe(true);

      const runtimeStarts: unknown[] = [];
      const handledCommands: unknown[] = [];
      const taskResult = await runTaskQueueConsumerOnce({
        projectId: "project_phase4",
        queue: server.queue,
        backend,
        runtimeProvider: "fake-provider",
        runtimeStarter: async (request) => {
          runtimeStarts.push(request);
          return { ok: true, runtimeSessionId: "runtime_phase4" };
        },
      });
      const controlResult = await runControlQueueConsumerOnce({
        projectId: "project_phase4",
        queue: server.queue,
        backend,
        commandHandler: async (request) => {
          handledCommands.push(request);
          return { ok: true };
        },
      });

      expect(taskResult).toMatchObject({
        processed: 2,
        acked: 2,
        retried: 0,
        deadLettered: 0,
        claimed: 1,
        noWork: 1,
        startupsSucceeded: 1,
      });
      expect(controlResult).toMatchObject({
        processed: 2,
        acked: 2,
        retried: 0,
        deadLettered: 0,
        claimed: 1,
        noWork: 1,
        commandsStarted: 1,
        commandsSucceeded: 1,
      });
      expect(runtimeStarts).toHaveLength(1);
      expect(handledCommands).toHaveLength(1);
      expect(server.queue.publishedHints).toEqual([]);
      expect(
        server.database.sqlite
          .query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions WHERE project_id = 'project_phase4' AND task_id = 'task_phase4'")
          .get()?.count,
      ).toBe(1);
      expect(
        server.database.sqlite
          .query<{ status: string }, []>("SELECT status FROM orchestrator_commands WHERE id = 'command_phase4_cancel'")
          .get(),
      ).toEqual({ status: "succeeded" });
      expect(
        server.database.sqlite
          .query<{ status: string; attempts: number }, []>(
            "SELECT status, attempts FROM outbox WHERE status = 'published' ORDER BY rowid LIMIT 2",
          )
          .all(),
      ).toEqual([
        { status: "published", attempts: 1 },
        { status: "published", attempts: 1 },
      ]);
    } finally {
      await server.close();
    }
  });

  test("Phase 6 fake provider smoke completes through API callbacks and canonical state", async () => {
    const server = await startApi();

    try {
      const services = createCanonicalStateServices(server.database.sqlite);
      const backend = createBackendInternalApiClient({ config: server.orchestratorConfig });
      const workspaceRoot = join(server.tempDir, "workspace");
      const clock: RuntimeClock = { now: () => new Date("2026-05-12T12:00:00.000Z") };
      const provider = createFakeRuntimeProvider({
        clock,
        fetch: rewriteFetchBase(server.apiConfig.bridge.callbackBaseUrl, server.baseUrl),
        bridgeRunMode: "after-startup",
        scenario: {
          runtimeSessionId: "runtime_phase6",
          output: [
            { stream: "stdout", text: "phase 6 stdout\n" },
            { stream: "stderr", text: "phase 6 stderr\n" },
          ],
          finalResponseText: "Phase 6 fake provider completed. https://example.test/phase6",
          finalResponseMetadata: { phase: "06", provider: "fake" },
          completionMetadata: { exitCode: 0 },
          cleanupReason: "phase6-smoke",
        },
      });

      services.createProject({ id: "project_phase6", slug: "phase-6", name: "Phase 6" });
      services.createTask({ id: "task_phase6", projectId: "project_phase6", title: "Run Phase 6 fake runtime" });
      server.queue.publishProjectTaskHint("project_phase6", { taskId: "task_phase6" });

      const result = await runTaskQueueConsumerOnce({
        projectId: "project_phase6",
        queue: server.queue,
        backend,
        runtimeProvider: "fake",
        runtimeStarter: createRuntimeStarter({ provider, workspaceRoot }),
        sessionIdFactory: () => "session_phase6",
      });

      expect(result).toMatchObject({
        processed: 1,
        acked: 1,
        claimed: 1,
        startupsSucceeded: 1,
        startupsFailed: 0,
      });
      expect(provider.state.started[0]?.bridgeRun).toMatchObject({
        status: "success",
        result: {
          heartbeatPosted: true,
          outputPosted: 2,
          documentsPosted: 2,
          finalResponsePosted: true,
          completionPosted: true,
          failurePosted: false,
          cleanupPosted: true,
        },
      });
      expect(
        server.database.sqlite
          .query<
            {
              task_status: string;
              session_status: string;
              runtime_provider: string | null;
              runtime_session_id: string | null;
              final_response_text: string | null;
              heartbeat_status: string;
              last_heartbeat_at: string | null;
            },
            []
          >(
            `
              SELECT
                t.status AS task_status,
                s.status AS session_status,
                s.runtime_provider,
                s.runtime_session_id,
                s.final_response_text,
                s.heartbeat_status,
                s.last_heartbeat_at
              FROM sessions s
              JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
              WHERE s.project_id = 'project_phase6' AND s.id = 'session_phase6'
            `,
          )
          .get(),
      ).toEqual({
        task_status: "completed",
        session_status: "succeeded",
        runtime_provider: "fake",
        runtime_session_id: "runtime_phase6",
        final_response_text: "Phase 6 fake provider completed. https://example.test/phase6",
        heartbeat_status: "fresh",
        last_heartbeat_at: "2026-05-12T12:00:00.000Z",
      });
      expect(readSessionOutputEvents(server.database.sqlite, "project_phase6", "session_phase6")).toEqual([
        { stream: "stdout", sequence: 1, byteOffset: 0, text: "phase 6 stdout\n" },
        { stream: "stderr", sequence: 2, byteOffset: 15, text: "phase 6 stderr\n" },
      ]);
      expect(
        server.database.sqlite
          .query<{ kind: string; uri: string }, []>(
            `
              SELECT kind, uri
              FROM artifacts
              WHERE project_id = 'project_phase6' AND task_id = 'task_phase6' AND session_id = 'session_phase6'
              ORDER BY kind, uri
            `,
          )
          .all(),
      ).toEqual([
        { kind: "document", uri: "agent-docs/fake-runtime-result.md" },
        { kind: "document", uri: "shared-docs/fake-runtime-summary.json" },
        { kind: "final_response_url", uri: "https://example.test/phase6" },
      ]);
      expect(
        server.database.sqlite
          .query<{ type: string }, []>(
            "SELECT type FROM events WHERE project_id = 'project_phase6' AND session_id = 'session_phase6' ORDER BY created_at, id",
          )
          .all()
          .map((event) => event.type),
      ).toEqual(
        expect.arrayContaining([
          "session.heartbeat",
          "session.output",
          "artifact.document.registered",
          "session.final_response.recorded",
          "session.completed",
          "session.cleanup",
        ]),
      );
    } finally {
      await server.close();
    }
  });

  test("Phase 6 fake provider failure paths report startup failure, runtime failure, and lost heartbeat", async () => {
    const server = await startApi();

    try {
      const services = createCanonicalStateServices(server.database.sqlite);
      const backend = createBackendInternalApiClient({ config: server.orchestratorConfig });
      const clock: RuntimeClock = { now: () => new Date("2026-05-12T12:30:00.000Z") };
      const projectId = "project_phase6_failures";

      services.createProject({ id: projectId, slug: "phase-6-failures", name: "Phase 6 Failures" });
      services.createTask({ id: "task_startup_failure", projectId, title: "Startup failure" });
      services.createTask({ id: "task_runtime_failure", projectId, title: "Runtime failure" });
      services.createTask({ id: "task_lost_heartbeat", projectId, title: "Lost heartbeat" });

      server.queue.publishProjectTaskHint(projectId, { taskId: "task_startup_failure" });
      const startupFailure = await runTaskQueueConsumerOnce({
        projectId,
        queue: server.queue,
        backend,
        runtimeProvider: "fake",
        runtimeStarter: createRuntimeStarter({
          provider: createFakeRuntimeProvider({
            scenario: {
              startup: "failure",
              startupErrorMessage: "fake sandbox image unavailable",
            },
          }),
        }),
        sessionIdFactory: () => "session_startup_failure",
      });

      expect(startupFailure).toMatchObject({
        processed: 1,
        acked: 1,
        claimed: 1,
        startupsSucceeded: 0,
        startupsFailed: 1,
      });
      expect(readTaskSessionStatus(server.database.sqlite, projectId, "session_startup_failure")).toEqual({
        task_status: "blocked",
        session_status: "failed",
      });
      expect(readLatestEventPayload(server.database.sqlite, projectId, "session_startup_failure", "session.startup_failed")).toMatchObject({
        errorMessage: "fake sandbox image unavailable",
      });

      const runtimeFailureProvider = createFakeRuntimeProvider({
        clock,
        fetch: rewriteFetchBase(server.apiConfig.bridge.callbackBaseUrl, server.baseUrl),
        bridgeRunMode: "after-startup",
        scenario: {
          runtimeSessionId: "runtime_failure",
          runtime: "failure",
          runtimeErrorMessage: "fake runtime exited 17",
          output: [{ stream: "stderr", text: "runtime failed\n" }],
          documents: [],
          failureMetadata: { exitCode: 17 },
          cleanupReason: "runtime-failed",
        },
      });
      server.queue.publishProjectTaskHint(projectId, { taskId: "task_runtime_failure" });
      const runtimeFailure = await runTaskQueueConsumerOnce({
        projectId,
        queue: server.queue,
        backend,
        runtimeProvider: "fake",
        runtimeStarter: createRuntimeStarter({ provider: runtimeFailureProvider, workspaceRoot: join(server.tempDir, "runtime-failure") }),
        sessionIdFactory: () => "session_runtime_failure",
      });

      expect(runtimeFailure).toMatchObject({
        processed: 1,
        acked: 1,
        claimed: 1,
        startupsSucceeded: 1,
        startupsFailed: 0,
      });
      expect(runtimeFailureProvider.state.started[0]?.bridgeRun).toMatchObject({
        status: "failure",
        result: {
          failurePosted: true,
          cleanupPosted: true,
        },
      });
      expect(readTaskSessionStatus(server.database.sqlite, projectId, "session_runtime_failure")).toEqual({
        task_status: "failed",
        session_status: "failed",
      });
      expect(readLatestEventPayload(server.database.sqlite, projectId, "session_runtime_failure", "session.failed")).toMatchObject({
        errorMessage: "fake runtime exited 17",
        metadata: { exitCode: 17 },
      });

      expect(services.claimNextTask({ projectId, sessionId: "session_lost_heartbeat", runtimeProvider: "fake" })).toMatchObject({
        ok: true,
      });
      expect(
        services.reportStartupSucceeded({
          projectId,
          sessionId: "session_lost_heartbeat",
          runtimeSessionId: "runtime_lost_heartbeat",
        }),
      ).toMatchObject({ ok: true });
      server.database.sqlite
        .query("UPDATE sessions SET last_heartbeat_at = '2026-05-12T11:00:00.000Z' WHERE project_id = ? AND id = ?")
        .run(projectId, "session_lost_heartbeat");

      const reconcile = await backend.reconcile({
        projectId,
        lostBefore: "2026-05-12T11:00:00.000Z",
        staleBefore: "2026-05-12T11:30:00.000Z",
        now: "2026-05-12T12:30:00.000Z",
      });

      expect(reconcile).toMatchObject({
        ok: true,
        body: {
          ok: true,
          lost: [{ id: "session_lost_heartbeat", status: "failed", heartbeatStatus: "lost" }],
          stale: [],
        },
      });
      expect(readTaskSessionStatus(server.database.sqlite, projectId, "session_lost_heartbeat")).toEqual({
        task_status: "blocked",
        session_status: "failed",
      });
    } finally {
      await server.close();
    }
  });
});

async function startApi(): Promise<{
  readonly tempDir: string;
  readonly baseUrl: string;
  readonly apiConfig: ReturnType<typeof loadConfig>;
  readonly orchestratorConfig: ReturnType<typeof loadConfig>;
  readonly database: ReturnType<typeof openApiDatabase>;
  readonly queue: ReturnType<typeof createRabbitMqAdapter>;
  readonly close: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-control-plane-smoke-"));
  cleanupPaths.push(tempDir);
  const dbPath = join(tempDir, "db", "web-sandbox.db");
  const baseEnv = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: dbPath,
  };
  const apiConfig = loadConfig(baseEnv);
  const database = openApiDatabase(baseEnv);
  const queue = createRabbitMqAdapter(apiConfig.rabbitmq);
  const app = createApiApp({ config: apiConfig, database, queue });
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("test API server did not bind to a TCP port");
  }

  const baseUrl = `http://127.0.0.1:${address.port}`;
  const orchestratorConfig = loadConfig({
    ...baseEnv,
    ORCHESTRATOR_BACKEND_INTERNAL_URL: baseUrl,
  });

  return {
    tempDir,
    baseUrl,
    apiConfig,
    orchestratorConfig,
    database,
    queue,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      database.close();
    },
  };
}

function rewriteFetchBase(fromBaseUrl: string, toBaseUrl: string): typeof fetch {
  const from = new URL(fromBaseUrl);
  const to = new URL(toBaseUrl);

  return async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const body = request.method === "GET" || request.method === "HEAD" ? undefined : await request.text();

    if (url.origin === from.origin) {
      url.protocol = to.protocol;
      url.host = to.host;
    }

    return fetch(url, {
      method: request.method,
      headers: request.headers,
      body,
    });
  };
}

function readSessionOutputEvents(
  database: ReturnType<typeof openApiDatabase>["sqlite"],
  projectId: string,
  sessionId: string,
): readonly Readonly<Record<string, unknown>>[] {
  return database
    .query<{ payload_json: string }, [string, string]>(
      "SELECT payload_json FROM events WHERE project_id = ? AND session_id = ? AND type = 'session.output'",
    )
    .all(projectId, sessionId)
    .map((event) => JSON.parse(event.payload_json) as Readonly<Record<string, unknown>>)
    .sort((left, right) => Number(left.sequence) - Number(right.sequence))
    .map((event) => ({
      stream: event.stream,
      sequence: event.sequence,
      byteOffset: event.byteOffset,
      text: event.text,
    }));
}

function readTaskSessionStatus(
  database: ReturnType<typeof openApiDatabase>["sqlite"],
  projectId: string,
  sessionId: string,
): { readonly task_status: string; readonly session_status: string } | null {
  return database
    .query<{ task_status: string; session_status: string }, [string, string]>(
      `
        SELECT t.status AS task_status, s.status AS session_status
        FROM sessions s
        JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
        WHERE s.project_id = ? AND s.id = ?
      `,
    )
    .get(projectId, sessionId);
}

function readLatestEventPayload(
  database: ReturnType<typeof openApiDatabase>["sqlite"],
  projectId: string,
  sessionId: string,
  type: string,
): Readonly<Record<string, unknown>> | null {
  const row = database
    .query<{ payload_json: string }, [string, string, string]>(
      `
        SELECT payload_json
        FROM events
        WHERE project_id = ? AND session_id = ? AND type = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(projectId, sessionId, type);

  return row ? (JSON.parse(row.payload_json) as Readonly<Record<string, unknown>>) : null;
}
