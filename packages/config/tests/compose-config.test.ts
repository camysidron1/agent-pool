import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

describe("compose control-plane config", () => {
  test("wires fake runtime services to API-owned web sandbox state", async () => {
    const compose = await readFile(join(process.cwd(), "deploy", "compose", "docker-compose.yml"), "utf8");

    expect(compose).toContain("AGENT_POOL_WEB_SANDBOX_DB_PATH: /data/web-sandbox.db");
    expect(compose).not.toContain(".agent-pool/data/agent-pool.db");
    expect(compose).not.toContain("~/.agent-pool/data/agent-pool.db");
    expect(compose).toContain("INTERNAL_SERVICE_TOKEN: ${INTERNAL_SERVICE_TOKEN:-compose-internal-service-token}");
    expect(compose).toContain("BRIDGE_CALLBACK_BASE_URL: ${BRIDGE_CALLBACK_BASE_URL:-http://api:3000}");
    expect(compose).toContain("RABBITMQ_MANAGEMENT_URL: http://guest:guest@rabbitmq:15672");
    expect(compose).toContain("RUNTIME_PROVIDER: ${RUNTIME_PROVIDER:-fake}");
    expect(compose).toContain("COMPOSE_SMOKE_PROJECT_ID: compose-smoke");
    expect(compose).toContain("E2B_API_KEY_ENV_NAME: ${E2B_API_KEY_ENV_NAME:-E2B_API_KEY}");
    expect(compose).toContain("E2B_TEMPLATE_ID: ${E2B_TEMPLATE_ID:-}");
    expect(compose).toContain("E2B_SANDBOX_IMAGE_ID: ${E2B_SANDBOX_IMAGE_ID:-}");
    expect(compose).toContain("E2B_ALLOWED_SECRET_ENV_NAMES: ${E2B_ALLOWED_SECRET_ENV_NAMES:-GITHUB_TOKEN,CODEX_API_KEY}");
    expect(compose).toContain("GITHUB_TOKEN: ${GITHUB_TOKEN:-}");
    expect(compose).toContain("AGENT_RUNNER_MODE: ${AGENT_RUNNER_MODE:-bridge-smoke}");
    expect(compose).toContain("CODEX_API_KEY: ${CODEX_API_KEY:-}");
    expect(compose).toContain("EGRESS_PROXY_URL: ${EGRESS_PROXY_URL:-}");
    expect(compose).toContain("EGRESS_PACKAGE_PROXY_URL: ${EGRESS_PACKAGE_PROXY_URL:-}");
    expect(compose).toContain("E2B_LOCAL_ALLOW_DIRECT_EGRESS: ${E2B_LOCAL_ALLOW_DIRECT_EGRESS:-false}");
    expect(compose).toContain("AGENT_POOL_ALLOWED_EGRESS_DOMAINS: ${AGENT_POOL_ALLOWED_EGRESS_DOMAINS:-github.com,api.github.com,registry.npmjs.org,api.openai.com}");
    expect(compose).toContain("GITHUB_APP_ID: ${GITHUB_APP_ID:-}");
    expect(compose).toContain("web:");
    expect(compose).toContain("bun run dev -- --host 0.0.0.0 --port 5173");
    expect(compose).toContain("caddy:");
    expect(compose).toContain("caddy:2.8.4-alpine");
    expect(compose).toContain("egress-gateway:");
    expect(compose).toContain("EGRESS_GATEWAY_BACKEND_INTERNAL_URL: http://api:3000");
    expect(compose).toContain("EGRESS_GATEWAY_DEFAULT_DENY: \"true\"");
    expect(compose).toContain("${AGENT_POOL_COMPOSE_EDGE_PORT:-3080}:8080");
    expect(compose).toContain("./Caddyfile:/etc/caddy/Caddyfile:ro");
    expect(compose.match(/healthcheck:/g)?.length).toBeGreaterThanOrEqual(8);
    expect(compose).toContain("condition: service_healthy");
  });

  test("routes the local full-stack edge through Caddy without bypassing backend auth", async () => {
    const caddyfile = await readFile(join(process.cwd(), "deploy", "compose", "Caddyfile"), "utf8");

    expect(caddyfile).toContain(":8080");
    expect(caddyfile).toContain("@notSse");
    expect(caddyfile).toContain("header Accept text/event-stream");
    expect(caddyfile).toContain("encode @notSse zstd gzip");
    expect(caddyfile).toContain("handle /api/*");
    expect(caddyfile).toContain("reverse_proxy api:3000");
    expect(caddyfile).toContain("handle /internal/*");
    expect(caddyfile).toContain("handle /callbacks/*");
    expect(caddyfile).toContain("handle /steering/*");
    expect(caddyfile).toContain("handle_path /orchestrator/*");
    expect(caddyfile).toContain("reverse_proxy orchestrator:3001");
    expect(caddyfile).toContain("reverse_proxy web:5173");
    expect(caddyfile).not.toContain(".agent-pool/data/agent-pool.db");
    expect(caddyfile).not.toContain("~/.agent-pool/data/agent-pool.db");
  });
});
