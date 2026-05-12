import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("compose control-plane config", () => {
  test("wires fake runtime services to API-owned web sandbox state", async () => {
    const compose = await readFile(join(process.cwd(), "deploy", "compose", "docker-compose.yml"), "utf8");

    expect(compose).toContain("AGENT_POOL_WEB_SANDBOX_DB_PATH: /data/web-sandbox.db");
    expect(compose).not.toContain(".agent-pool/data/agent-pool.db");
    expect(compose).not.toContain("~/.agent-pool/data/agent-pool.db");
    expect(compose).toContain("BRIDGE_CALLBACK_BASE_URL: http://api:3000");
    expect(compose).toContain("RABBITMQ_MANAGEMENT_URL: http://guest:guest@rabbitmq:15672");
    expect(compose).toContain("RUNTIME_PROVIDER: fake");
    expect(compose).toContain("COMPOSE_SMOKE_PROJECT_ID: compose-smoke");
    expect(compose.match(/healthcheck:/g)?.length).toBeGreaterThanOrEqual(5);
    expect(compose).toContain("condition: service_healthy");
  });
});
