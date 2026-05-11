import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";
import { createStorageAdapter } from "@agent-pool/storage";
import { checkBackendInternalHealth } from "../../orchestrator/src/backend-client";

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
});

async function startApi(): Promise<{
  readonly baseUrl: string;
  readonly apiConfig: ReturnType<typeof loadConfig>;
  readonly orchestratorConfig: ReturnType<typeof loadConfig>;
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
