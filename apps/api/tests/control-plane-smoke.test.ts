import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter } from "@agent-pool/queue";
import { createStorageAdapter } from "@agent-pool/storage";
import { checkBackendInternalHealth, createBackendInternalApiClient } from "../../orchestrator/src/backend-client";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";

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
        body: { ok: true, claimed: true, task: { id: "task_run" }, session: { id: "session_run", status: "starting" } },
      });
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
});

async function startApi(): Promise<{
  readonly baseUrl: string;
  readonly apiConfig: ReturnType<typeof loadConfig>;
  readonly orchestratorConfig: ReturnType<typeof loadConfig>;
  readonly database: ReturnType<typeof openApiDatabase>;
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
  const app = createApiApp({ config: apiConfig, database });
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
    baseUrl,
    apiConfig,
    orchestratorConfig,
    database,
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
