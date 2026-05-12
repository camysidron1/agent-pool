import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API service skeleton", () => {
  test("health reports config and migrated database state", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.service).toBe("agent-pool-api");
      expect(body.authMode).toBe("test");
      expect(body.database.connected).toBe(true);
      expect(body.database.path).toEndWith("web-sandbox.db");
      expect(body.database.appliedMigrations).toBeGreaterThan(0);
      expect(body.adapters).toMatchObject({
        queue: { kind: "rabbitmq", connected: false },
        storage: { kind: "local" },
      });
    } finally {
      await close();
    }
  });

  test("internal health requires service-token auth", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/health`);
      const invalid = await fetch(`${baseUrl}/internal/health`, {
        headers: {
          [config.serviceToken.headerName]: "wrong",
        },
      });
      const ok = await fetch(`${baseUrl}/internal/health`, {
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, subject: "internal-service" });
    } finally {
      await close();
    }
  });

  test("internal orchestrator namespace requires service-token auth and exposes structured placeholders", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, { method: "POST" });
      const invalid = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: "wrong",
        },
      });
      const ok = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(ok.status).toBe(501);
      expect(await ok.json()).toMatchObject({
        ok: false,
        error: "internal_orchestrator_endpoint_not_implemented",
        method: "POST",
        path: "/internal/orchestrator/sessions/session_1/startup-succeeded",
      });
    } finally {
      await close();
    }
  });

  test("claimNextTask internal endpoint claims work and returns structured no-work response", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });

      const claimed = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "test-provider" }),
      });
      const noWork = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a", sessionId: "session_2" }),
      });

      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({
        ok: true,
        claimed: true,
        task: { id: "task_1", projectId: "project_a", status: "running" },
        session: { id: "session_1", taskId: "task_1", status: "starting", runtimeProvider: "test-provider" },
      });
      expect(noWork.status).toBe(200);
      expect(await noWork.json()).toEqual({ ok: true, claimed: false, reason: "no_eligible_task" });
    } finally {
      await close();
    }
  });

  test("claimNextCommand internal endpoint claims queued commands and returns structured no-work response", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });
      const command = services.requestCommand({
        id: "command_cancel",
        projectId: "project_a",
        taskId: "task_1",
        type: "cancel",
        payload: { reason: "operator" },
      });
      expect(command.ok).toBe(true);

      const claimed = await fetch(`${baseUrl}/internal/orchestrator/commands/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a" }),
      });
      const noWork = await fetch(`${baseUrl}/internal/orchestrator/commands/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a" }),
      });

      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({
        ok: true,
        claimed: true,
        command: {
          id: "command_cancel",
          projectId: "project_a",
          taskId: "task_1",
          sessionId: null,
          type: "cancel",
          status: "running",
          payload: { reason: "operator" },
        },
      });
      expect(noWork.status).toBe(200);
      expect(await noWork.json()).toEqual({ ok: true, claimed: false, reason: "no_queued_command" });
    } finally {
      await close();
    }
  });

  test("command report endpoints transition running commands and handle duplicates idempotently", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });
      const requested = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_1", type: "cancel" });
      expect(requested.ok).toBe(true);
      const claimed = services.claimNextCommand({ projectId: "project_a" });
      expect(claimed.ok).toBe(true);

      const started = await postCommandReport(baseUrl, config, "command_cancel", "started", { projectId: "project_a" });
      const succeeded = await postCommandReport(baseUrl, config, "command_cancel", "succeeded", { projectId: "project_a" });
      const duplicate = await postCommandReport(baseUrl, config, "command_cancel", "succeeded", { projectId: "project_a" });
      const failedConflict = await postCommandReport(baseUrl, config, "command_cancel", "failed", {
        projectId: "project_a",
        errorMessage: "too late",
      });

      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({
        ok: true,
        idempotent: false,
        command: { id: "command_cancel", status: "running" },
        event: { type: "command.started" },
      });
      expect(succeeded.status).toBe(200);
      expect(await succeeded.json()).toMatchObject({ ok: true, idempotent: false, command: { id: "command_cancel", status: "succeeded" } });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ok: true, idempotent: true, command: { id: "command_cancel", status: "succeeded" } });
      expect(failedConflict.status).toBe(409);
      expect(await failedConflict.json()).toMatchObject({ ok: false, error: { code: "conflict" } });
    } finally {
      await close();
    }
  });

  test("internal orchestrator placeholder endpoints are not exposed as public routes", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const publicRoute = await fetch(`${baseUrl}/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const missingCommandProject = await fetch(`${baseUrl}/internal/orchestrator/commands/cmd_1/started`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const startupReport = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-failed`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const reconcile = await fetch(`${baseUrl}/internal/orchestrator/reconcile`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(publicRoute.status).toBe(404);
      expect(missingCommandProject.status).toBe(400);
      expect(await missingCommandProject.json()).toMatchObject({ error: "missing_project_id" });
      expect(startupReport.status).toBe(501);
      expect(await startupReport.json()).toMatchObject({ error: "internal_orchestrator_endpoint_not_implemented" });
      expect(reconcile.status).toBe(501);
      expect(await reconcile.json()).toMatchObject({ error: "internal_orchestrator_endpoint_not_implemented" });
    } finally {
      await close();
    }
  });

  test("metrics exposes service and database migration gauges", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/metrics`);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("agent_pool_api_info");
      expect(text).toContain("agent_pool_api_database_connected 1");
      expect(text).toContain("agent_pool_api_database_applied_migrations");
      expect(text).toContain("agent_pool_api_queue_adapter_initialized 1");
      expect(text).toContain("agent_pool_api_storage_adapter_initialized 1");
    } finally {
      await close();
    }
  });
});

async function postCommandReport(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  commandId: string,
  report: "started" | "succeeded" | "failed",
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator/commands/${commandId}/${report}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}

async function startTestApi(): Promise<{
  readonly baseUrl: string;
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: ReturnType<typeof openApiDatabase>;
  readonly close: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-app-"));
  cleanupPaths.push(tempDir);
  const dbPath = join(tempDir, "db", "web-sandbox.db");
  const env = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: dbPath,
  };
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const app = createApiApp({ config, database });
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("test API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
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
