import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createKubernetesSmokePlan,
  parseKubernetesSmokeArgs,
  runKubernetesSmokeCli,
} from "../../../deploy/kubernetes/smoke-kubernetes";

describe("deployed Kubernetes smoke runner", () => {
  test("keeps deployed smoke opt-in and out of the default test script", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts.test).toBe("bun test apps packages");
    expect(scripts.test).not.toMatch(/smoke:compose|smoke:kubernetes|smoke:e2b|docker|compose|kubernetes|kubectl|e2b/i);
    expect(scripts["smoke:kubernetes"]).toBe("bun run deploy/kubernetes/smoke-kubernetes.ts");
    expect(scripts["smoke:e2b"]).toBe("bun run deploy/compose/e2b-smoke.ts");
  });

  test("builds a deployed smoke plan without DB access or secret leakage", async () => {
    const plan = createKubernetesSmokePlan({
      apiUrl: "https://agent-pool.example.com/",
      orchestratorUrl: "https://orchestrator.example.com/",
      prometheusUrl: "https://prometheus.example.com/",
      serviceToken: "secret-token",
      timeoutMs: 42_000,
    });
    const source = await readFile(join(process.cwd(), "deploy", "kubernetes", "smoke-kubernetes.ts"), "utf8");

    expect(plan).toMatchObject({
      apiUrl: "https://agent-pool.example.com",
      orchestratorUrl: "https://orchestrator.example.com",
      prometheusUrl: "https://prometheus.example.com",
      timeoutMs: 42_000,
      serviceToken: "[REDACTED]",
      readiness: [
        { label: "api health", url: "https://agent-pool.example.com/health" },
        { label: "orchestrator health", url: "https://orchestrator.example.com/health" },
        { label: "prometheus health", url: "https://prometheus.example.com/-/healthy" },
      ],
      requests: {
        seed: { method: "POST", url: "https://agent-pool.example.com/internal/smoke/seed" },
        status: { method: "GET", url: "https://agent-pool.example.com/internal/smoke/status" },
      },
      e2bSmokeCommand: [
        "bun",
        "run",
        "smoke:e2b",
        "--api-url",
        "https://agent-pool.example.com",
        "--service-token",
        "<redacted-service-token>",
        "--repository-url",
        "https://github.com/example/tiny-fixture.git",
      ],
    });
    expect(JSON.stringify(plan)).not.toContain("secret-token");
    expect(source).not.toMatch(/@agent-pool\/db|bun:sqlite|openApiDatabase|openWebSandboxDatabase|AGENT_POOL_WEB_SANDBOX_DB_PATH/);
  });

  test("supports dry-run output without network Kubernetes Docker E2B or DB calls", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runKubernetesSmokeCli(["--dry-run", "--api-url", "https://api.example.com", "--service-token", "secret-token"], {
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const plan = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(plan.serviceToken).toBe("[REDACTED]");
    expect(plan.requests.seed.url).toBe("https://api.example.com/internal/smoke/seed");
    expect(JSON.stringify(plan)).not.toContain("secret-token");
  });

  test("requires a service token before touching deployed endpoints", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runKubernetesSmokeCli(["--timeout-ms", "1000"], {
      env: {},
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });

    expect(code).toBe(1);
    expect(fetches).toBe(0);
    expect(JSON.parse(writes.join(""))).toEqual({
      ok: false,
      error: "INTERNAL_SERVICE_TOKEN or --service-token is required for deployed smoke",
    });
  });

  test("uses API smoke endpoints and Prometheus verification for deployed fake-provider smoke", async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly serviceToken: string | null;
      readonly contentType: string | null;
    }> = [];
    const writes: string[] = [];
    const code = await runKubernetesSmokeCli(
      [
        "--api-url",
        "https://api.example.com",
        "--orchestrator-url",
        "https://orchestrator.example.com",
        "--prometheus-url",
        "https://prometheus.example.com",
        "--service-token",
        "service-token",
        "--timeout-ms",
        "1000",
      ],
      {
        write: (text) => writes.push(text),
        sleep: async () => {},
        fetch: async (input, init) => {
          const url = String(input);
          const parsed = new URL(url);
          const headers = new Headers(init?.headers);
          requests.push({
            url,
            method: init?.method ?? "GET",
            serviceToken: headers.get("x-agent-pool-service-token"),
            contentType: headers.get("content-type"),
          });

          if (parsed.pathname === "/internal/smoke/seed") {
            return Response.json({ ok: true, projectId: "deployed-smoke", taskId: "deployed-smoke-task-1" });
          }

          if (parsed.pathname === "/internal/smoke/status") {
            return Response.json({
              ok: true,
              finalResponse: { recorded: true },
              completion: { completed: true },
              cleanup: { completed: true },
            });
          }

          if (parsed.pathname === "/api/v1/targets") {
            return Response.json({
              status: "success",
              data: {
                activeTargets: [
                  { health: "up", labels: { job: "agent-pool-api" } },
                  { health: "up", labels: { job: "agent-pool-orchestrator" } },
                ],
              },
            });
          }

          if (parsed.pathname === "/api/v1/query") {
            return Response.json({
              status: "success",
              data: {
                resultType: "vector",
                result: [{ value: [0, "1"] }],
              },
            });
          }

          return Response.json({ ok: true });
        },
      },
    );
    const payload = JSON.parse(writes.join(""));
    const smokeRequests = requests.filter((request) => request.url.startsWith("https://api.example.com/internal/smoke/"));
    const prometheusRequests = requests.filter((request) => request.url.startsWith("https://prometheus.example.com/api/v1/"));

    expect(code).toBe(0);
    expect(payload).toMatchObject({
      ok: true,
      seed: { ok: true },
      status: { ok: true },
      prometheus: {
        targets: { api: true, orchestrator: true },
      },
    });
    expect(smokeRequests).toEqual([
      {
        url: "https://api.example.com/internal/smoke/seed",
        method: "POST",
        serviceToken: "service-token",
        contentType: "application/json",
      },
      {
        url: "https://api.example.com/internal/smoke/status",
        method: "GET",
        serviceToken: "service-token",
        contentType: null,
      },
    ]);
    expect(prometheusRequests.map((request) => new URL(request.url).pathname)).toEqual([
      "/api/v1/targets",
      "/api/v1/query",
      "/api/v1/query",
      "/api/v1/query",
    ]);
    expect(JSON.stringify(payload)).not.toContain("service-token");
  });

  test("parses deployed smoke flags", () => {
    expect(
      parseKubernetesSmokeArgs([
        "--plan",
        "--api-url",
        "https://api.example.com",
        "--orchestrator-url",
        "https://orchestrator.example.com",
        "--prometheus-url",
        "https://prometheus.example.com",
        "--service-token",
        "token",
        "--service-token-header",
        "X-Custom-Service-Token",
        "--timeout-ms",
        "5000",
      ]),
    ).toEqual({
      dryRun: true,
      apiUrl: "https://api.example.com",
      orchestratorUrl: "https://orchestrator.example.com",
      prometheusUrl: "https://prometheus.example.com",
      serviceToken: "token",
      serviceTokenHeaderName: "x-custom-service-token",
      timeoutMs: 5000,
    });
  });
});
