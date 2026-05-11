import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";

import { checkBackendInternalHealth } from "../src/backend-client";
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
});
