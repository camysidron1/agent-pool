import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";

import { checkBackendInternalHealth, createBackendInternalApiClient } from "../src/backend-client";
import { createOrchestratorFetchHandler } from "../src/server";

describe("orchestrator service skeleton", () => {
  test("health exposes configured backend internal URL", async () => {
    const config = loadConfig({ AUTH_MODE: "test", ORCHESTRATOR_BACKEND_INTERNAL_URL: "http://api.internal.test:3000" });
    const handler = createOrchestratorFetchHandler({ config });
    const response = handler(new Request("http://orchestrator.test/health"));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      ok: true,
      service: "agent-pool-orchestrator",
      authMode: "test",
      backendInternalUrl: "http://api.internal.test:3000",
      adapters: {
        queue: { kind: "rabbitmq", connected: false },
        storage: { kind: "local" },
      },
    });
  });

  test("metrics exposes backend internal configuration gauge", async () => {
    const handler = createOrchestratorFetchHandler({ config: loadConfig({ AUTH_MODE: "test" }) });
    const response = handler(new Request("http://orchestrator.test/metrics"));
    const text = await response.text();

    expect(response.status).toBe(200);
    expect(text).toContain("agent_pool_orchestrator_info");
    expect(text).toContain("agent_pool_orchestrator_backend_internal_configured 1");
    expect(text).toContain("agent_pool_orchestrator_queue_adapter_initialized 1");
    expect(text).toContain("agent_pool_orchestrator_storage_adapter_initialized 1");
  });

  test("backend internal health client sends service-token auth and handles success", async () => {
    const config = loadConfig({ AUTH_MODE: "test", ORCHESTRATOR_BACKEND_INTERNAL_URL: "http://api.internal.test" });
    const seenHeaders: Record<string, string | null> = {};
    const result = await checkBackendInternalHealth({
      config,
      fetch: async (input, init) => {
        seenHeaders.url = String(input);
        seenHeaders.token = new Headers(init?.headers).get(config.serviceToken.headerName);
        return Response.json({ ok: true }, { status: 200 });
      },
    });

    expect(result).toEqual({ ok: true, status: 200, body: { ok: true } });
    expect(seenHeaders.url).toBe("http://api.internal.test/internal/health");
    expect(seenHeaders.token).toBe(config.serviceToken.token);
  });

  test("backend internal health client handles backend failures", async () => {
    const config = loadConfig({ AUTH_MODE: "test" });
    const result = await checkBackendInternalHealth({
      config,
      fetch: async () => Response.json({ ok: false }, { status: 403 }),
    });

    expect(result).toEqual({ ok: false, status: 403, body: { ok: false } });
  });

  test("backend internal API client sends service-token auth for orchestrator workflow methods", async () => {
    const config = loadConfig({ AUTH_MODE: "test", ORCHESTRATOR_BACKEND_INTERNAL_URL: "http://api.internal.test" });
    const requests: Array<{
      readonly path: string;
      readonly method: string;
      readonly token: string | null;
      readonly contentType: string | null;
      readonly body: unknown;
    }> = [];
    const client = createBackendInternalApiClient({
      config,
      fetch: async (input, init) => {
        const url = new URL(String(input));
        const headers = new Headers(init?.headers);
        const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
        requests.push({
          path: url.pathname,
          method: init?.method ?? "GET",
          token: headers.get(config.serviceToken.headerName),
          contentType: headers.get("content-type"),
          body,
        });

        switch (url.pathname) {
          case "/internal/orchestrator/tasks/claim-next":
            return Response.json({ ok: true, claimed: true, task: { id: "task_1" }, session: { id: "session_1" } });
          case "/internal/orchestrator/commands/claim-next":
            return Response.json({ ok: true, claimed: false, reason: "no_queued_command" });
          case "/internal/orchestrator/commands/command_1/started":
            return Response.json({ ok: false, error: { code: "invalid_state", message: "not running" } }, { status: 409 });
          case "/internal/orchestrator/commands/command_1/succeeded":
          case "/internal/orchestrator/commands/command_1/failed":
            return Response.json({ ok: true, idempotent: false, command: { id: "command_1" }, event: null, outbox: null });
          case "/internal/orchestrator/sessions/session_1/startup-succeeded":
            return Response.json({ ok: true, idempotent: false, session: { id: "session_1" }, task: { id: "task_1" }, event: null, outbox: null });
          case "/internal/orchestrator/sessions/session_2/startup-failed":
            return Response.json({ ok: true, idempotent: false, session: { id: "session_2" }, task: { id: "task_2" }, event: null, outbox: null });
          case "/internal/orchestrator/sessions/session_1/heartbeat":
            return Response.json({ ok: true, session: { id: "session_1" }, event: { type: "session.heartbeat" }, outbox: { id: "outbox_1" } });
          case "/internal/orchestrator/reconcile":
            return Response.json({ ok: true, stale: [{ id: "session_stale" }], lost: [{ id: "session_lost" }], events: [], outbox: [] });
          default:
            return Response.json({ ok: false, error: "unexpected path" }, { status: 404 });
        }
      },
    });

    const claimedTask = await client.claimNextTask({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "fake" });
    const noCommand = await client.claimNextCommand({ projectId: "project_a" });
    const commandStartedError = await client.reportCommandStarted({ projectId: "project_a", commandId: "command_1" });
    const commandSucceeded = await client.reportCommandSucceeded({ projectId: "project_a", commandId: "command_1" });
    const commandFailed = await client.reportCommandFailed({ projectId: "project_a", commandId: "command_1", errorMessage: "boom" });
    const startupSucceeded = await client.reportStartupSucceeded({
      projectId: "project_a",
      sessionId: "session_1",
      runtimeSessionId: "runtime_1",
    });
    const startupFailed = await client.reportStartupFailed({
      projectId: "project_a",
      sessionId: "session_2",
      errorMessage: "startup timed out",
    });
    const heartbeat = await client.reportSessionHeartbeat({
      projectId: "project_a",
      sessionId: "session_1",
      observedAt: "2026-01-01T00:00:00.000Z",
    });
    const reconcile = await client.reconcile({
      projectId: "project_a",
      staleBefore: "2026-01-01T00:01:00.000Z",
      lostBefore: "2026-01-01T00:00:00.000Z",
      now: "2026-01-01T00:02:00.000Z",
    });

    expect(claimedTask).toMatchObject({ ok: true, status: 200, body: { ok: true, claimed: true } });
    expect(noCommand).toMatchObject({ ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_queued_command" } });
    expect(commandStartedError).toMatchObject({ ok: false, status: 409, body: { ok: false, error: { code: "invalid_state" } } });
    expect(commandSucceeded).toMatchObject({ ok: true, body: { ok: true, command: { id: "command_1" } } });
    expect(commandFailed).toMatchObject({ ok: true, body: { ok: true, command: { id: "command_1" } } });
    expect(startupSucceeded).toMatchObject({ ok: true, body: { ok: true, session: { id: "session_1" } } });
    expect(startupFailed).toMatchObject({ ok: true, body: { ok: true, session: { id: "session_2" } } });
    expect(heartbeat).toMatchObject({ ok: true, body: { ok: true, session: { id: "session_1" } } });
    expect(reconcile).toMatchObject({ ok: true, body: { ok: true, stale: [{ id: "session_stale" }], lost: [{ id: "session_lost" }] } });
    expect(requests.map((request) => request.path)).toEqual([
      "/internal/orchestrator/tasks/claim-next",
      "/internal/orchestrator/commands/claim-next",
      "/internal/orchestrator/commands/command_1/started",
      "/internal/orchestrator/commands/command_1/succeeded",
      "/internal/orchestrator/commands/command_1/failed",
      "/internal/orchestrator/sessions/session_1/startup-succeeded",
      "/internal/orchestrator/sessions/session_2/startup-failed",
      "/internal/orchestrator/sessions/session_1/heartbeat",
      "/internal/orchestrator/reconcile",
    ]);
    for (const request of requests) {
      expect(request.method).toBe("POST");
      expect(request.token).toBe(config.serviceToken.token);
      expect(request.contentType).toBe("application/json");
    }
    expect(requests[0]?.body).toEqual({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "fake" });
    expect(requests[4]?.body).toEqual({ projectId: "project_a", errorMessage: "boom" });
    expect(requests[7]?.body).toEqual({ projectId: "project_a", observedAt: "2026-01-01T00:00:00.000Z" });
  });
});
