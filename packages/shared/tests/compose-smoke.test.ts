import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  createComposeSmokePlan,
  isPrometheusVerificationComplete,
  parseComposeSmokeArgs,
  readPrometheusVerification,
  runComposeSmokeCli,
} from "../../../deploy/compose/smoke-compose";

describe("compose smoke runner", () => {
  test("keeps Docker compose smoke out of the default test script", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts.test).toBe("bun test apps packages");
    expect(scripts.test).not.toMatch(/smoke:compose|docker|compose|rabbitmq|minio|prometheus/i);
    expect(scripts["smoke:compose"]).toBe("bun run deploy/compose/smoke-compose.ts");
  });

  test("builds a bounded compose smoke plan without using the legacy TUI database", () => {
    const plan = createComposeSmokePlan({
      cwd: "/repo",
      projectName: "agent-pool-test",
      apiUrl: "http://api.local/",
      orchestratorUrl: "http://orchestrator.local/",
      prometheusUrl: "http://prometheus.local/",
      timeoutMs: 42_000,
    });

    expect(plan.composeFile).toBe("/repo/deploy/compose/docker-compose.yml");
    expect(plan.projectName).toBe("agent-pool-test");
    expect(plan.apiUrl).toBe("http://api.local");
    expect(plan.orchestratorUrl).toBe("http://orchestrator.local");
    expect(plan.prometheusUrl).toBe("http://prometheus.local");
    expect(plan.timeoutMs).toBe(42_000);
    expect(plan.commands.map((command) => command.command.join(" "))).toEqual([
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test up -d --wait",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test down --timeout 15 -v --remove-orphans",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test logs --no-color --tail 200",
    ]);
    expect(JSON.stringify(plan)).not.toContain(".agent-pool/data/agent-pool.db");
    expect(plan.readiness.map((endpoint) => endpoint.label)).toEqual([
      "api health",
      "orchestrator health",
      "rabbitmq management",
      "minio readiness",
      "prometheus health",
    ]);
    expect(plan.readiness.at(-1)).toEqual({ label: "prometheus health", url: "http://prometheus.local/-/healthy" });
  });

  test("supports dry-run output without executing docker or network calls", async () => {
    const writes: string[] = [];
    let commandRuns = 0;
    let fetches = 0;
    const code = await runComposeSmokeCli(["--dry-run", "--project-name", "agent-pool-dry"], {
      cwd: "/repo",
      write: (text) => writes.push(text),
      runCommand: async () => {
        commandRuns += 1;
      },
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });

    expect(code).toBe(0);
    expect(commandRuns).toBe(0);
    expect(fetches).toBe(0);
    expect(JSON.parse(writes.join(""))).toMatchObject({
      projectName: "agent-pool-dry",
      commands: [
        { label: "boot compose stack" },
        { label: "tear down compose stack" },
        { label: "collect compose logs" },
      ],
      readiness: [
        { label: "api health" },
        { label: "orchestrator health" },
        { label: "rabbitmq management" },
        { label: "minio readiness" },
        { label: "prometheus health" },
      ],
    });
  });

  test("parses smoke compose flags for local execution", () => {
    expect(
      parseComposeSmokeArgs([
        "--plan",
        "--compose-file",
        "compose.yml",
        "--project-name",
        "agent-pool-custom",
        "--api-url",
        "http://127.0.0.1:3100",
      "--orchestrator-url",
      "http://127.0.0.1:3101",
      "--prometheus-url",
      "http://127.0.0.1:9191",
      "--service-token",
        "token",
        "--timeout-ms",
        "5000",
        "--no-teardown",
      ]),
    ).toEqual({
      dryRun: true,
      composeFile: "compose.yml",
      projectName: "agent-pool-custom",
      apiUrl: "http://127.0.0.1:3100",
      orchestratorUrl: "http://127.0.0.1:3101",
      prometheusUrl: "http://127.0.0.1:9191",
      serviceToken: "token",
      timeoutMs: 5000,
      teardown: false,
    });
  });

  test("uses API service-token smoke endpoints for seed and status instead of DB access", async () => {
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly serviceToken: string | null;
      readonly contentType: string | null;
    }> = [];
    const serviceToken = "boundary-token";
    const code = await runComposeSmokeCli(["--service-token", serviceToken, "--timeout-ms", "1000"], {
      cwd: "/repo",
      write: () => {},
      runCommand: async () => {},
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
          return Response.json({ ok: true, projectId: "compose-smoke", taskId: "compose-smoke-task-1" });
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
    });
    const smokeRequests = requests.filter((request) => request.url.startsWith("http://127.0.0.1:3000/internal/smoke/"));
    const smokeSource = await readFile(join(process.cwd(), "deploy", "compose", "smoke-compose.ts"), "utf8");

    expect(code).toBe(0);
    expect(smokeRequests).toEqual([
      {
        url: "http://127.0.0.1:3000/internal/smoke/seed",
        method: "POST",
        serviceToken,
        contentType: "application/json",
      },
      {
        url: "http://127.0.0.1:3000/internal/smoke/status",
        method: "GET",
        serviceToken,
        contentType: null,
      },
    ]);
    expect(smokeSource).not.toMatch(/@agent-pool\/db|bun:sqlite|openApiDatabase|openWebSandboxDatabase|AGENT_POOL_WEB_SANDBOX_DB_PATH/);
  });

  test("parses Prometheus target and query verification for API and orchestrator metrics", async () => {
    const requests: string[] = [];
    const verification = await readPrometheusVerification(
      { prometheusUrl: "http://prometheus.local" },
      async (input) => {
        const url = new URL(String(input));
        requests.push(`${url.pathname}?${url.searchParams.toString()}`);

        if (url.pathname === "/api/v1/targets") {
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

        const query = url.searchParams.get("query");
        const value =
          query === "agent_pool_api_outbox_published"
            ? "9"
            : query === "agent_pool_orchestrator_task_consumer_runs_total"
              ? "2"
              : query === "agent_pool_orchestrator_task_claim_total"
                ? "1"
                : "0";

        return Response.json({
          status: "success",
          data: {
            resultType: "vector",
            result: [{ value: [0, value] }],
          },
        });
      },
    );

    expect(verification).toEqual({
      targets: { api: true, orchestrator: true },
      metrics: {
        apiOutboxPublished: 9,
        orchestratorTaskConsumerRuns: 2,
        orchestratorTaskClaims: 1,
      },
    });
    expect(isPrometheusVerificationComplete(verification)).toBe(true);
    expect(requests).toEqual([
      "/api/v1/targets?state=active",
      "/api/v1/query?query=agent_pool_api_outbox_published",
      "/api/v1/query?query=agent_pool_orchestrator_task_consumer_runs_total",
      "/api/v1/query?query=agent_pool_orchestrator_task_claim_total",
    ]);
  });

  test("captures failure diagnostics and still tears down without masking the original error", async () => {
    const writes: string[] = [];
    const commands: string[] = [];
    const code = await runComposeSmokeCli(["--timeout-ms", "1000"], {
      cwd: "/repo",
      write: (text) => writes.push(text),
      runCommand: async (command) => {
        commands.push(command.join(" "));
        if (command.includes("up")) {
          throw new Error("compose boot failed");
        }
      },
      runCommandOutput: async (command) => {
        expect(command.join(" ")).toBe(
          "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-compose-smoke logs --no-color --tail 200",
        );
        return "api-1 | startup failed\norchestrator-1 | waiting";
      },
      fetch: async (input) => {
        expect(String(input)).toBe("http://127.0.0.1:3000/internal/smoke/status");
        return Response.json({ ok: true, task: { status: "queued" } });
      },
    });
    const payloads = writes.map((write) => JSON.parse(write));

    expect(code).toBe(1);
    expect(commands).toEqual([
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-compose-smoke up -d --wait",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-compose-smoke down --timeout 15 -v --remove-orphans",
    ]);
    expect(payloads[0]).toMatchObject({
      ok: false,
      error: "compose boot failed",
      diagnostics: {
        statusSnapshot: { ok: true, status: 200, body: { ok: true, task: { status: "queued" } } },
        logs: "api-1 | startup failed\norchestrator-1 | waiting",
      },
    });
  });
});
