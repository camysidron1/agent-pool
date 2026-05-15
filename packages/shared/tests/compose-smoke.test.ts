import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createComposeSmokePlan,
  isPrometheusVerificationComplete,
  parseComposeSmokeArgs,
  readPrometheusVerification,
  runComposeSmokeCli,
} from "../../../deploy/compose/smoke-compose";
import { AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST } from "@agent-pool/runtime";
import {
  createE2BLiveSmokeDoctorReport,
  createE2BReadinessReport,
  createE2BSmokePlan,
  parseE2BSmokeArgs,
  runE2BSmokeCli,
  validateE2BEvidenceBundle,
} from "../../../deploy/compose/e2b-smoke";
import { loadLocalEnv, parseLocalEnvFile, type EnvSource } from "../../../deploy/local-env";

describe("compose smoke runner", () => {
  test("keeps Docker compose smoke out of the default test script", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};
    const gitignore = await readFile(join(process.cwd(), ".gitignore"), "utf8");

    expect(scripts.test).toBe("bun test apps packages");
    expect(scripts.test).not.toMatch(/smoke:compose|smoke:e2b|docker|compose|rabbitmq|minio|prometheus|e2b/i);
    expect(scripts["smoke:compose"]).toBe("bun run deploy/compose/smoke-compose.ts");
    expect(scripts["smoke:e2b"]).toBe("bun run deploy/compose/e2b-smoke.ts");
    expect(gitignore).toContain(".env\n");
    expect(gitignore).toContain(".env.*\n");
  });

  test("parses local .env files with shell-style values", () => {
    expect(
      parseLocalEnvFile(`
        # local smoke only
        export RUNTIME_PROVIDER=e2b
        BRIDGE_CALLBACK_BASE_URL="https://bridge.example.test"
        E2B_API_KEY='e2b-secret'
        GITHUB_TOKEN=github-secret # local only
      `),
    ).toEqual({
      RUNTIME_PROVIDER: "e2b",
      BRIDGE_CALLBACK_BASE_URL: "https://bridge.example.test",
      E2B_API_KEY: "e2b-secret",
      GITHUB_TOKEN: "github-secret",
    });
  });

  test("builds a bounded compose smoke plan without using the legacy TUI database", () => {
    const plan = createComposeSmokePlan({
      cwd: "/repo",
      projectName: "agent-pool-test",
      apiUrl: "http://api.local/",
      orchestratorUrl: "http://orchestrator.local/",
      edgeUrl: "http://edge.local/",
      prometheusUrl: "http://prometheus.local/",
      timeoutMs: 42_000,
    });

    expect(plan.composeFile).toBe("/repo/deploy/compose/docker-compose.yml");
    expect(plan.projectName).toBe("agent-pool-test");
    expect(plan.apiUrl).toBe("http://api.local");
    expect(plan.orchestratorUrl).toBe("http://orchestrator.local");
    expect(plan.edgeUrl).toBe("http://edge.local");
    expect(plan.prometheusUrl).toBe("http://prometheus.local");
    expect(plan.timeoutMs).toBe(42_000);
    expect(plan.bootOnly).toBe(false);
    expect(plan.commands.map((command) => command.command.join(" "))).toEqual([
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test up -d --wait",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test down --timeout 15 -v --remove-orphans",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test logs --no-color --tail 200",
    ]);
    expect(JSON.stringify(plan)).not.toContain(".agent-pool/data/agent-pool.db");
    expect(plan.readiness.map((endpoint) => endpoint.label)).toEqual([
      "api health",
      "orchestrator health",
      "egress gateway health",
      "caddy edge health",
      "api through caddy",
      "web through caddy",
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
        { label: "egress gateway health" },
        { label: "caddy edge health" },
        { label: "api through caddy" },
        { label: "web through caddy" },
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
      "--edge-url",
      "http://127.0.0.1:8181",
      "--prometheus-url",
      "http://127.0.0.1:9191",
      "--service-token",
        "token",
        "--timeout-ms",
        "5000",
        "--boot-only",
        "--no-teardown",
      ]),
    ).toEqual({
      dryRun: true,
      composeFile: "compose.yml",
      projectName: "agent-pool-custom",
      apiUrl: "http://127.0.0.1:3100",
      orchestratorUrl: "http://127.0.0.1:3101",
      edgeUrl: "http://127.0.0.1:8181",
      prometheusUrl: "http://127.0.0.1:9191",
      serviceToken: "token",
      timeoutMs: 5000,
      teardown: false,
      bootOnly: true,
    });
  });

  test("supports boot-only local stack startup without seeding smoke tasks", async () => {
    const writes: string[] = [];
    const commands: string[] = [];
    const fetches: string[] = [];
    const code = await runComposeSmokeCli(["--boot-only", "--edge-url", "http://127.0.0.1:3180"], {
      cwd: "/repo",
      write: (text) => writes.push(text),
      runCommand: async (command) => {
        commands.push(command.join(" "));
      },
      fetch: async (input) => {
        fetches.push(String(input));
        return Response.json({ ok: true });
      },
    });
    const payload = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(commands).toEqual([
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-compose-smoke up -d --wait",
    ]);
    expect(fetches).toEqual([
      "http://127.0.0.1:3000/health",
      "http://127.0.0.1:3001/health",
      "http://127.0.0.1:3002/health",
      "http://127.0.0.1:3180/healthz",
      "http://127.0.0.1:3180/health",
      "http://127.0.0.1:3180/",
      "http://127.0.0.1:15672/api/overview",
      "http://127.0.0.1:9000/minio/health/ready",
      "http://127.0.0.1:9090/-/healthy",
    ]);
    expect(payload).toEqual({
      ok: true,
      booted: true,
      edgeUrl: "http://127.0.0.1:3180",
      apiUrl: "http://127.0.0.1:3000",
      orchestratorUrl: "http://127.0.0.1:3001",
    });
  });

  test("loads .env into docker compose commands without printing secrets", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-pool-compose-env-"));
    await writeFile(
      join(cwd, ".env"),
      [
        "RUNTIME_PROVIDER=e2b",
        "BRIDGE_CALLBACK_BASE_URL=https://bridge.example.test",
        "E2B_API_KEY=e2b-secret",
        "E2B_TEMPLATE_ID=template-1",
        "GITHUB_TOKEN=github-secret",
        "E2B_ALLOWED_SECRET_ENV_NAMES=GITHUB_TOKEN",
      ].join("\n"),
    );
    const writes: string[] = [];
    const commandEnvs: Array<EnvSource | undefined> = [];
    const code = await runComposeSmokeCli(["--boot-only"], {
      cwd,
      write: (text) => writes.push(text),
      runCommand: async (_command, options) => {
        commandEnvs.push(options.env);
      },
      fetch: async () => Response.json({ ok: true }),
    });

    expect(code).toBe(0);
    expect(commandEnvs).toHaveLength(1);
    expect(commandEnvs[0]?.RUNTIME_PROVIDER).toBe("e2b");
    expect(commandEnvs[0]?.BRIDGE_CALLBACK_BASE_URL).toBe("https://bridge.example.test");
    expect(commandEnvs[0]?.E2B_TEMPLATE_ID).toBe("template-1");
    expect(commandEnvs[0]?.E2B_ALLOWED_SECRET_ENV_NAMES).toBe("GITHUB_TOKEN");
    expect(Boolean(commandEnvs[0]?.E2B_API_KEY?.trim())).toBe(true);
    expect(Boolean(commandEnvs[0]?.GITHUB_TOKEN?.trim())).toBe(true);
    expect(writes.join("")).not.toContain("e2b-secret");
    expect(writes.join("")).not.toContain("github-secret");
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

  test("builds an opt-in E2B dry-run plan without credentials, network, Docker, or DB access", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(["--dry-run", "--api-url", "http://api.local/", "--repository-url", "https://github.com/example/tiny-fixture.git"], {
      env: {
        AUTH_MODE: "test",
        E2B_TEMPLATE_ID: "template-1",
      },
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const plan = JSON.parse(writes.join(""));
    const source = await readFile(join(process.cwd(), "deploy", "compose", "e2b-smoke.ts"), "utf8");

    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(plan).toMatchObject({
      runtimeProvider: "e2b",
      apiUrl: "http://api.local",
      serviceToken: "[REDACTED]",
      missingCredentials: ["E2B_API_KEY", "GITHUB_TOKEN"],
      runtimeSource: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/e2b-smoke",
      },
      requests: {
        seed: {
          method: "POST",
          url: "http://api.local/internal/smoke/seed",
          body: {
            runtimeSource: {
              repositoryUrl: "https://github.com/example/tiny-fixture.git",
            },
          },
        },
        status: {
          method: "GET",
          url: "http://api.local/internal/smoke/status",
        },
      },
      cleanup: {
        provider: "e2b",
        sandboxId: "<runtime-session-id>",
        action: "destroy sandbox through RuntimeProvider.stopSession",
      },
      maliciousFixtures: {
        enabled: false,
        liveExecution: "not_requested",
        fixtureIds: [],
      },
    });
    expect(plan.launchSpec.environment.secrets).toEqual({ GITHUB_TOKEN: "[REDACTED]" });
    expect(JSON.stringify(plan)).not.toContain("dry-run-github-token");
    expect(JSON.stringify(plan)).not.toContain("dry-run-session-token");
    expect(source).not.toMatch(/@agent-pool\/db|bun:sqlite|openApiDatabase|openWebSandboxDatabase|AGENT_POOL_WEB_SANDBOX_DB_PATH/);
  });

  test("documents opt-in malicious E2B smoke fixtures without running live providers", async () => {
    const writes: string[] = [];
    const code = await runE2BSmokeCli(["--dry-run", "--agent-runner-mode", "codex", "--malicious-fixtures"], {
      env: {
        AUTH_MODE: "test",
        E2B_TEMPLATE_ID: "template-1",
        E2B_LOCAL_ALLOW_DIRECT_EGRESS: "true",
      },
      write: (text) => writes.push(text),
      fetch: async () => {
        throw new Error("dry-run malicious fixtures must not call the network");
      },
    });
    const plan = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(plan.maliciousFixtures).toMatchObject({
      enabled: true,
      liveExecution: "dry_run_only",
      fixtureIds: expect.arrayContaining([
        "postinstall-lifecycle-script",
        "unexpected-package-add",
        "lockfile-mutation",
        "undeclared-egress",
        "token-file-read",
        "gh-auth-token",
        "metadata-instruction-injection",
        "credential-persistence",
      ]),
    });
    expect(plan.missingCredentials).toEqual([
      "E2B_API_KEY",
      "CODEX_API_KEY",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_INSTALLATION_ID",
    ]);
  });

  test("generates and validates redacted E2B dry-run evidence bundles", async () => {
    const writes: string[] = [];
    const code = await runE2BSmokeCli(["--dry-run", "--evidence", "--agent-runner-mode", "codex"], {
      now: () => Date.parse("2026-05-15T00:00:00.000Z"),
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
        EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
        AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      },
      write: (text) => writes.push(text),
    });
    const evidence = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(evidence).toMatchObject({
      kind: "agent-pool-e2b-live-readiness-evidence",
      schemaVersion: 1,
      generatedAt: "2026-05-15T00:00:00.000Z",
      status: "dry-run",
      runtimeSource: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        commandProfile: "agent-pool-bun-pr",
      },
      smokeRequests: {
        status: { method: "GET", url: "http://127.0.0.1:3000/internal/smoke/status" },
      },
      snapshotDecision: { status: "not_observed", reasons: [] },
      redaction: {
        containsNoServiceToken: true,
        containsNoGithubToken: true,
        containsNoE2BApiKey: true,
        containsNoCodexApiKey: true,
        containsNoProxyCredentials: true,
        containsNoBridgeOrSessionToken: true,
        containsNoLegacyTuiDbPath: true,
        containsNoApiDbPath: true,
      },
    });
    expect(evidence.launchSpecHash).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validateE2BEvidenceBundle(evidence)).toMatchObject({ ok: true, status: "pass" });
    expect(JSON.stringify(evidence)).not.toContain("e2b-secret");
    expect(JSON.stringify(evidence)).not.toContain("codex-secret");
    expect(JSON.stringify(evidence)).not.toContain("github-app-private-key");
    expect(JSON.stringify(evidence)).not.toContain("proxy-secret");
    expect(JSON.stringify(evidence)).not.toContain("~/.agent-pool/data/agent-pool.db");
  });

  test("reports blocked and live-smoke evidence with stage diagnostics", async () => {
    const blockedWrites: string[] = [];
    await runE2BSmokeCli(["--readiness", "--evidence", "--agent-runner-mode", "codex"], {
      now: () => Date.parse("2026-05-15T00:00:00.000Z"),
      env: { AUTH_MODE: "test" },
      write: (text) => blockedWrites.push(text),
    });
    const blocked = JSON.parse(blockedWrites.join(""));
    expect(blocked.status).toBe("blocked");
    expect(blocked.readinessSummary.status).toBe("blocked");
    expect(blocked.readinessSummary.blockedChecks).toEqual(expect.arrayContaining(["e2b-provider-credentials", "codex-api-key", "github-app-broker"]));
    expect(validateE2BEvidenceBundle(blocked)).toMatchObject({ ok: false, status: "blocked" });

    const liveWrites: string[] = [];
    const code = await runE2BSmokeCli(["--evidence", "--api-url", "http://api.local", "--service-token", "service-secret", "--timeout-ms", "1000"], {
      now: () => Date.parse("2026-05-15T01:00:00.000Z"),
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN",
        GITHUB_TOKEN: "github-secret",
      },
      write: (text) => liveWrites.push(text),
      fetch: async (input) => {
        if (String(input).endsWith("/internal/smoke/seed")) {
          return Response.json({ ok: true, projectId: "compose-smoke", taskId: "compose-smoke-task-1" });
        }
        return Response.json({
          ok: true,
          finalResponse: { recorded: true },
          completion: { completed: true },
          cleanup: { completed: true },
          diagnostics: {
            currentStage: "snapshot",
            failedStage: null,
            stages: [{ id: "snapshot", status: "passed", detail: "snapshot created and sandbox destroyed" }],
            securityEvents: [{ securityKind: "credentials-scrub-succeeded", count: 1 }],
          },
        });
      },
    });
    const live = JSON.parse(liveWrites.join(""));

    expect(code).toBe(0);
    expect(live).toMatchObject({
      status: "pass",
      stageDiagnostics: {
        currentStage: "snapshot",
        stages: [{ id: "snapshot", status: "passed" }],
      },
      snapshotDecision: { status: "passed", reasons: ["snapshot created and sandbox destroyed"] },
    });
    expect(validateE2BEvidenceBundle(live)).toMatchObject({ ok: true, status: "pass" });
    expect(JSON.stringify(live)).not.toContain("github-secret");
    expect(JSON.stringify(live)).not.toContain("service-secret");
  });

  test("rejects leaked secrets and validates evidence files offline", async () => {
    const evidence = JSON.parse(
      await new Response(
        JSON.stringify(
          createE2BSmokePlan({
            env: {
              AUTH_MODE: "test",
              E2B_TEMPLATE_ID: "template-1",
            },
          }),
        ),
      ).text(),
    );
    const bundle = {
      kind: "agent-pool-e2b-live-readiness-evidence",
      schemaVersion: 1,
      generatedAt: "2026-05-15T00:00:00.000Z",
      status: "pass",
      readinessSummary: { status: null, missingCredentials: [], missingSettings: [], blockedChecks: [] },
      launchSpecHash: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      redactedLaunchSpec: evidence.launchSpec,
      runtimeSource: evidence.runtimeSource,
      securityReadiness: evidence.securityReadiness,
      smokeRequests: evidence.requests,
      statusResult: { token: "ghp_abcdefghijklmnopqrstuvwxyz123456", path: "~/.agent-pool/data/agent-pool.db" },
      stageDiagnostics: { currentStage: "snapshot" },
      cleanup: evidence.cleanup,
      snapshotDecision: { status: "passed", reasons: [] },
      blockers: [],
      redaction: {
        containsNoServiceToken: true,
        containsNoGithubToken: true,
        containsNoE2BApiKey: true,
        containsNoCodexApiKey: true,
        containsNoProxyCredentials: true,
        containsNoBridgeOrSessionToken: true,
        containsNoLegacyTuiDbPath: true,
        containsNoApiDbPath: true,
      },
    };
    const invalid = validateE2BEvidenceBundle(bundle);
    const validBundle = { ...bundle, statusResult: { token: "[REDACTED]", path: "[REDACTED_DB_PATH]" } };
    const writes: string[] = [];
    const code = await runE2BSmokeCli(["--validate-evidence", "evidence.json"], {
      readFile: async () => JSON.stringify(validBundle),
      write: (text) => writes.push(text),
    });

    expect(invalid).toMatchObject({ ok: false, status: "invalid" });
    expect(invalid.redactionViolations.length).toBeGreaterThan(0);
    expect(code).toBe(0);
    expect(JSON.parse(writes.join(""))).toMatchObject({ ok: true, status: "pass" });
  });

  test("loads .env for E2B smoke planning without leaking secret values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-pool-e2b-env-"));
    await writeFile(
      join(cwd, ".env"),
      [
        "AUTH_MODE=test",
        "BRIDGE_CALLBACK_BASE_URL=https://bridge.example.test",
        "E2B_API_KEY=e2b-secret",
        "E2B_TEMPLATE_ID=template-1",
        "E2B_ALLOWED_SECRET_ENV_NAMES=GITHUB_TOKEN",
        "GITHUB_TOKEN=github-secret",
      ].join("\n"),
    );
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(["--dry-run"], {
      cwd,
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const plan = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(plan.missingCredentials).toEqual([]);
    expect(plan.missingSettings).toEqual([]);
    expect(plan.launchSpec.bridge.callbackBaseUrl).toBe("https://bridge.example.test");
    expect(plan.launchSpec.environment.secrets).toEqual({ GITHUB_TOKEN: "[REDACTED]" });
    expect(JSON.stringify(plan)).not.toContain("e2b-secret");
    expect(JSON.stringify(plan)).not.toContain("github-secret");
  });

  test("builds a local real-agent E2B smoke plan with Codex runtime source metadata", async () => {
    const writes: string[] = [];
    const code = await runE2BSmokeCli(["--dry-run", "--agent-runner-mode", "codex"], {
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
        E2B_LOCAL_ALLOW_DIRECT_EGRESS: "true",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      },
      write: (text) => writes.push(text),
    });
    const plan = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(plan.missingCredentials).toEqual([]);
    expect(plan.missingSettings).toEqual([]);
    expect(plan.runtimeSource).toMatchObject({
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
      commandProfile: "agent-pool-bun-pr",
    });
    expect(plan.requests.seed.body.runtimeSource).toMatchObject({
      allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
      commandProfile: "agent-pool-bun-pr",
    });
    expect(plan.launchSpec.runner.mode).toBe("codex");
    expect(plan.launchSpec.network).toMatchObject({ allowInternetAccess: true, allowOut: [] });
    expect(plan.launchSpec.environment.secrets).toEqual({
      GITHUB_TOKEN: "[REDACTED]",
      CODEX_API_KEY: "[REDACTED]",
    });
    expect(JSON.stringify(plan)).not.toContain("e2b-secret");
    expect(JSON.stringify(plan)).not.toContain("codex-secret");
    expect(JSON.stringify(plan)).not.toContain("github-app-private-key");
  });

  test("dry-run Codex E2B smoke exposes proxy snapshot and command-policy readiness evidence", async () => {
    const writes: string[] = [];
    const code = await runE2BSmokeCli(["--dry-run", "--agent-runner-mode", "codex"], {
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
        EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
        AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      },
      write: (text) => writes.push(text),
    });
    const plan = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(plan.missingCredentials).toEqual([]);
    expect(plan.missingSettings).toEqual([]);
    expect(plan.launchSpec.network).toMatchObject({
      egressMode: "proxy",
      allowInternetAccess: false,
      allowPublicTraffic: false,
      allowOut: ["10.0.10.25/32"],
    });
    expect(plan.securityReadiness).toMatchObject({
      execution: {
        defaultTests: "fake-provider-safe",
        liveE2B: "opt-in",
        packageProxySmoke: "opt-in",
      },
      network: {
        egressMode: "proxy",
        proxyOnly: true,
        allowInternetAccess: false,
        allowPublicTraffic: false,
        allowOut: ["10.0.10.25/32"],
        packageProxyMode: "controlled-cache",
        packageProxyUrl: "[REDACTED]",
      },
      commandPolicy: {
        profile: "agent-pool-bun-pr",
        enforcedBy: ["codex rules", "bridge command supervisor", "backend runtime-source validation"],
      },
      credentials: {
        github: "brokered-github-app-installation-token",
        codex: "env-api-key",
        redactedSecretNames: ["CODEX_API_KEY", "GITHUB_TOKEN"],
        rawSecretsPresent: false,
      },
      snapshotPolicy: {
        successSnapshots: "clean-terminal-sessions-only",
        blockedBy: expect.arrayContaining(["egress-denied", "install-failed", "lockfile-mutated", "scrub-incomplete", "command-denied", "grace-timeout"]),
        cleanupAction: "destroy sandbox through RuntimeProvider.stopSession",
      },
      liveSmokePrerequisites: {
        missingCredentials: [],
        missingSettings: [],
      },
    });
    expect(JSON.stringify(plan)).not.toContain("e2b-secret");
    expect(JSON.stringify(plan)).not.toContain("codex-secret");
    expect(JSON.stringify(plan)).not.toContain("github-app-private-key");
    expect(JSON.stringify(plan)).not.toContain("proxy-secret");
  });

  test("reports offline live E2B readiness without provider network or secret leakage", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(["--readiness", "--agent-runner-mode", "codex"], {
      env: {
        AUTH_MODE: "test",
      },
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const report = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(report).toMatchObject({
      ok: true,
      kind: "e2b-readiness",
      status: "blocked",
      agentRunnerMode: "codex",
      sideEffects: [],
      missingCredentials: ["E2B_API_KEY", "CODEX_API_KEY", "GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY", "GITHUB_APP_INSTALLATION_ID"],
      missingSettings: [
        "E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID",
        "EGRESS_PROXY_URL and EGRESS_PROXY_ALLOW_OUT or E2B_LOCAL_ALLOW_DIRECT_EGRESS=true",
      ],
    });
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "callback-url",
        status: "block",
        nextAction: "Expose the local Caddy/API edge through a tunnel or use the deployed HTTPS API URL.",
      }),
    );
    expect(report.nextAction).toBe("Resolve blocked readiness checks, then rerun the readiness report.");
    expect(JSON.stringify(report)).not.toContain("dry-run-github-token");
    expect(JSON.stringify(report)).not.toContain("dry-run-codex-api-key");
  });

  test("reports ready offline E2B readiness for complete proxy-only Codex config", () => {
    const report = createE2BReadinessReport({
      agentRunnerMode: "codex",
      env: {
        AUTH_MODE: "test",
        BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
        EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
        AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      },
    });

    expect(report.status).toBe("ready");
    expect(report.nextAction).toBe("Run opt-in live E2B smoke when you are ready.");
    expect(report.checks.every((check) => check.status === "pass")).toBe(true);
    expect(report.securityReadiness.network).toMatchObject({
      egressMode: "proxy",
      proxyOnly: true,
      allowInternetAccess: false,
      allowPublicTraffic: false,
      allowOut: ["10.0.10.25/32"],
    });
    expect(JSON.stringify(report)).not.toContain("e2b-secret");
    expect(JSON.stringify(report)).not.toContain("codex-secret");
    expect(JSON.stringify(report)).not.toContain("github-app-private-key");
    expect(JSON.stringify(report)).not.toContain("proxy-secret");
  });

  test("reports a redacted live smoke doctor profile without side effects", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(
      [
        "--doctor",
        "--agent-runner-mode",
        "codex",
        "--api-url",
        "http://api-user:api-secret@127.0.0.1:3080",
        "--repository-url",
        "https://github.com/example/tiny-fixture.git",
      ],
      {
        env: {
          AUTH_MODE: "test",
          BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
          E2B_API_KEY: "e2b-secret",
          E2B_TEMPLATE_ID: "template-1",
          E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
          E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
          CODEX_API_KEY: "codex-secret",
          GITHUB_APP_ID: "12345",
          GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
          GITHUB_APP_INSTALLATION_ID: "67890",
          EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
          EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
          AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
        },
        write: (text) => writes.push(text),
        fetch: async () => {
          fetches += 1;
          throw new Error("doctor must not call the network by default");
        },
      },
    );
    const report = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(report).toMatchObject({
      ok: true,
      kind: "e2b-live-smoke-doctor",
      status: "ready",
      sideEffects: [],
      runProfile: {
        callbackBaseUrl: "https://callback.agentpool.app",
        callbackHealthUrl: "https://callback.agentpool.app/health",
        githubAppVerifyUrl: expect.stringContaining("/internal/orchestrator/github-app/verify"),
        seedUrl: expect.stringContaining("/internal/smoke/seed"),
        statusUrl: expect.stringContaining("/internal/smoke/status"),
      },
      fixture: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/e2b-smoke",
        commandProfile: "agent-pool-bun-pr",
      },
    });
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "doctor-api-url", status: "pass" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "doctor-fixture-egress-domains", status: "pass" }));
    expect(JSON.stringify(report)).not.toContain("api-secret");
    expect(JSON.stringify(report)).not.toContain("e2b-secret");
    expect(JSON.stringify(report)).not.toContain("codex-secret");
    expect(JSON.stringify(report)).not.toContain("github-app-private-key");
    expect(JSON.stringify(report)).not.toContain("proxy-secret");
  });

  test("blocks the live smoke doctor on missing prerequisites without touching providers", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(["--doctor", "--agent-runner-mode", "codex"], {
      env: {
        AUTH_MODE: "test",
      },
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const report = JSON.parse(writes.join(""));

    expect(code).toBe(1);
    expect(fetches).toBe(0);
    expect(report.status).toBe("blocked");
    expect(report.nextAction).toBe("Doctor found blockers; resolve them before launching a live E2B sandbox.");
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "e2b-provider-credentials", status: "block" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "callback-url", status: "block" }));
    expect(report.readiness.missingCredentials).toEqual([
      "E2B_API_KEY",
      "CODEX_API_KEY",
      "GITHUB_APP_ID",
      "GITHUB_APP_PRIVATE_KEY",
      "GITHUB_APP_INSTALLATION_ID",
    ]);
    expect(JSON.stringify(report)).not.toContain("dry-run-github-token");
    expect(JSON.stringify(report)).not.toContain("dry-run-codex-api-key");
  });

  test("warns in the doctor for direct egress and non-namespaced fixture branches", () => {
    const report = createE2BLiveSmokeDoctorReport({
      agentRunnerMode: "codex",
      taskBranchPrefix: "smoke/task",
      env: {
        AUTH_MODE: "test",
        BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
        E2B_LOCAL_ALLOW_DIRECT_EGRESS: "true",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
      },
    });

    expect(report.status).toBe("warning");
    expect(report.ok).toBe(true);
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "egress-policy", status: "warn" }));
    expect(report.checks).toContainEqual(expect.objectContaining({ id: "doctor-fixture-branch-prefix", status: "warn" }));
    expect(JSON.stringify(report)).not.toContain("e2b-secret");
    expect(JSON.stringify(report)).not.toContain("codex-secret");
    expect(JSON.stringify(report)).not.toContain("github-app-private-key");
  });

  test("warns when offline readiness uses the local direct-egress override", () => {
    const report = createE2BReadinessReport({
      agentRunnerMode: "codex",
      env: {
        AUTH_MODE: "test",
        BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
        E2B_LOCAL_ALLOW_DIRECT_EGRESS: "true",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
      },
    });

    expect(report.status).toBe("warning");
    expect(report.checks).toContainEqual(
      expect.objectContaining({
        id: "egress-policy",
        status: "warn",
        detail: "Direct egress is enabled for local/test use.",
      }),
    );
    expect(report.nextAction).toBe("Resolve readiness warnings before production use; dry-run smoke is still safe.");
  });

  test("verifies callback reachability with distinct opt-in diagnostics", async () => {
    const completeEnv: EnvSource = {
      AUTH_MODE: "test",
      BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
      E2B_API_KEY: "e2b-secret",
      E2B_TEMPLATE_ID: "template-1",
      E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
      E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
      CODEX_API_KEY: "codex-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
      GITHUB_APP_INSTALLATION_ID: "67890",
      EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
      EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
      AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
    };
    const run = async (response: Response | Error): Promise<{ readonly code: number; readonly report: Record<string, unknown>; readonly requests: readonly string[] }> => {
      const writes: string[] = [];
      const requests: string[] = [];
      const code = await runE2BSmokeCli(["--readiness", "--verify-callback", "--agent-runner-mode", "codex", "--callback-timeout-ms", "25"], {
        env: completeEnv,
        write: (text) => writes.push(text),
        fetch: async (input, init) => {
          requests.push(String(input));
          expect(new Headers(init?.headers).get("x-agent-pool-service-token")).toBeNull();
          if (response instanceof Error) throw response;
          return response;
        },
      });
      return { code, report: JSON.parse(writes.join("")), requests };
    };

    const reachable = await run(Response.json({ ok: true, service: "agent-pool-api" }));
    const notFound = await run(Response.json({ ok: false }, { status: 404 }));
    const authFailed = await run(Response.json({ ok: false }, { status: 401 }));
    const timeout = await run(Object.assign(new Error("request timed out"), { name: "AbortError" }));

    expect(reachable).toMatchObject({
      code: 0,
      requests: ["https://callback.agentpool.app/health"],
      report: {
        status: "ready",
        callbackReachability: { ok: true, status: "reachable", httpStatus: 200 },
      },
    });
    expect(notFound).toMatchObject({
      code: 1,
      report: {
        status: "blocked",
        callbackReachability: { ok: false, status: "not-found", httpStatus: 404 },
      },
    });
    expect(authFailed).toMatchObject({
      code: 1,
      report: {
        callbackReachability: { ok: false, status: "auth-failed", httpStatus: 401 },
      },
    });
    expect(timeout).toMatchObject({
      code: 1,
      report: {
        callbackReachability: { ok: false, status: "timeout", httpStatus: null },
      },
    });
    expect(JSON.stringify(reachable.report)).not.toContain("github-app-private-key");
    expect(JSON.stringify(reachable.report)).not.toContain("codex-secret");
    expect(JSON.stringify(reachable.report)).not.toContain("proxy-secret");
  });

  test("blocks local-only and non-HTTPS callback reachability without fetching", async () => {
    const completeEnv: EnvSource = {
      AUTH_MODE: "test",
      E2B_API_KEY: "e2b-secret",
      E2B_TEMPLATE_ID: "template-1",
      E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
      E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
      CODEX_API_KEY: "codex-secret",
      GITHUB_APP_ID: "12345",
      GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
      GITHUB_APP_INSTALLATION_ID: "67890",
      EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
      EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
      AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
    };
    const run = async (callbackBaseUrl: string) => {
      const writes: string[] = [];
      let fetches = 0;
      const code = await runE2BSmokeCli(["--readiness", "--verify-callback", "--agent-runner-mode", "codex"], {
        env: { ...completeEnv, BRIDGE_CALLBACK_BASE_URL: callbackBaseUrl },
        write: (text) => writes.push(text),
        fetch: async () => {
          fetches += 1;
          return Response.json({ ok: true });
        },
      });
      return { code, fetches, report: JSON.parse(writes.join("")) };
    };

    await expect(run("http://127.0.0.1:3080")).resolves.toMatchObject({
      code: 1,
      fetches: 0,
      report: { callbackReachability: { status: "local-only" } },
    });
    await expect(run("http://callback.agentpool.app")).resolves.toMatchObject({
      code: 1,
      fetches: 0,
      report: { callbackReachability: { status: "wrong-protocol" } },
    });
  });

  test("reports missing E2B smoke credentials before touching the API", async () => {
    const writes: string[] = [];
    let fetches = 0;
    const code = await runE2BSmokeCli(["--timeout-ms", "1000"], {
      env: {
        AUTH_MODE: "test",
        E2B_TEMPLATE_ID: "template-1",
      },
      write: (text) => writes.push(text),
      fetch: async () => {
        fetches += 1;
        return Response.json({ ok: true });
      },
    });
    const payload = JSON.parse(writes.join(""));

    expect(code).toBe(1);
    expect(fetches).toBe(0);
    expect(payload).toEqual({
      ok: false,
      error: "missing required E2B smoke settings: E2B_API_KEY, GITHUB_TOKEN",
      missingCredentials: ["E2B_API_KEY", "GITHUB_TOKEN"],
      missingSettings: [],
    });
  });

  test("uses smoke seed and status endpoints for opt-in E2B execution", async () => {
    const writes: string[] = [];
    const requests: Array<{
      readonly url: string;
      readonly method: string;
      readonly serviceToken: string | null;
      readonly contentType: string | null;
      readonly body: unknown;
    }> = [];
    const code = await runE2BSmokeCli(["--api-url", "http://api.local", "--service-token", "service-secret", "--timeout-ms", "1000"], {
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN",
        GITHUB_TOKEN: "github-secret",
      },
      write: (text) => writes.push(text),
      fetch: async (input, init) => {
        const body = init?.body ? JSON.parse(String(init.body)) : null;
        requests.push({
          url: String(input),
          method: init?.method ?? "GET",
          serviceToken: new Headers(init?.headers).get("x-agent-pool-service-token"),
          contentType: new Headers(init?.headers).get("content-type"),
          body,
        });

        if (String(input).endsWith("/internal/smoke/seed")) {
          return Response.json({ ok: true, projectId: "compose-smoke", taskId: "compose-smoke-task-1" });
        }

        return Response.json({
          ok: true,
          finalResponse: { recorded: true },
          completion: { completed: true },
          cleanup: { completed: true },
        });
      },
    });
    const payload = JSON.parse(writes.join(""));

    expect(code).toBe(0);
    expect(requests).toEqual([
      {
        url: "http://api.local/internal/smoke/seed",
        method: "POST",
        serviceToken: "service-secret",
        contentType: "application/json",
        body: {
          runtimeSource: {
            repositoryUrl: "https://github.com/example/tiny-fixture.git",
            baseRef: "main",
            taskBranchPrefix: "agent-pool/e2b-smoke",
          },
        },
      },
      {
        url: "http://api.local/internal/smoke/status",
        method: "GET",
        serviceToken: "service-secret",
        contentType: null,
        body: null,
      },
    ]);
    expect(payload).toMatchObject({ ok: true, seed: { ok: true }, status: { ok: true } });
    expect(JSON.stringify(payload)).not.toContain("github-secret");
    expect(JSON.stringify(payload)).not.toContain("e2b-secret");
    expect(JSON.stringify(payload)).not.toContain("service-secret");
  });

  test("attributes opt-in E2B smoke failures to staged diagnostics", async () => {
    const baseEnv: EnvSource = {
      AUTH_MODE: "test",
      E2B_API_KEY: "e2b-secret",
      E2B_TEMPLATE_ID: "template-1",
      E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN",
      GITHUB_TOKEN: "github-secret",
    };
    const runFailure = async (stage: string, status = stage === "snapshot" ? "risk" : "failed") => {
      const writes: string[] = [];
      const code = await runE2BSmokeCli(["--api-url", "http://api.local", "--service-token", "service-secret", "--timeout-ms", "1000"], {
        env: baseEnv,
        write: (text) => writes.push(text),
        fetch: async (input) => {
          if (String(input).endsWith("/internal/smoke/seed")) {
            return Response.json({ ok: true, projectId: "compose-smoke", taskId: "compose-smoke-task-1" });
          }
          return Response.json({
            ok: true,
            failure: { failed: true },
            diagnostics: {
              currentStage: stage,
              failedStage: stage,
              stages: [{ id: stage, status }],
              logSnippets: [{ text: "redacted diagnostic" }],
            },
          });
        },
        sleep: async () => {},
      });
      return { code, payload: JSON.parse(writes.join("")) };
    };

    const seedWrites: string[] = [];
    const seedCode = await runE2BSmokeCli(["--api-url", "http://api.local", "--service-token", "service-secret"], {
      env: baseEnv,
      write: (text) => seedWrites.push(text),
      fetch: async () => Response.json({ ok: false, diagnostics: { failedStage: "seed" } }, { status: 500 }),
    });
    expect(seedCode).toBe(1);
    expect(JSON.parse(seedWrites.join(""))).toMatchObject({
      ok: false,
      stage: "seed",
      diagnostics: { failedStage: "seed" },
    });

    for (const stage of ["sandbox-create", "bootstrap-clone", "install", "codex", "pr", "cleanup", "snapshot"]) {
      const result = await runFailure(stage);
      expect(result).toMatchObject({
        code: 1,
        payload: {
          ok: false,
          stage,
          diagnostics: {
            failedStage: stage,
            stages: [{ id: stage }],
          },
        },
      });
    }
  });

  test("verifies GitHub App readiness before seeding Codex E2B smoke tasks", async () => {
    const writes: string[] = [];
    const requests: string[] = [];
    const code = await runE2BSmokeCli(["--api-url", "http://api.local", "--service-token", "service-secret", "--agent-runner-mode", "codex"], {
      env: {
        AUTH_MODE: "test",
        BRIDGE_CALLBACK_BASE_URL: "https://callback.agentpool.app",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON: JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST),
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN,CODEX_API_KEY",
        CODEX_API_KEY: "codex-secret",
        GITHUB_APP_ID: "12345",
        GITHUB_APP_PRIVATE_KEY: "github-app-private-key",
        GITHUB_APP_INSTALLATION_ID: "67890",
        EGRESS_PROXY_URL: "http://proxy-user:proxy-secret@egress-gateway.internal:8080",
        EGRESS_PROXY_ALLOW_OUT: "10.0.10.25/32",
        AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      },
      write: (text) => writes.push(text),
      fetch: async (input, init) => {
        requests.push(String(input));
        expect(new Headers(init?.headers).get("x-agent-pool-service-token")).toBe("service-secret");
        if (String(input).endsWith("/internal/orchestrator/github-app/verify")) {
          return Response.json(
            {
              ok: false,
              error: "github_app_permissions_insufficient",
              repositoryUrl: "https://github.com/example/tiny-fixture.git",
              missingPermissions: ["contents:write"],
            },
            { status: 403 },
          );
        }
        throw new Error("Codex E2B smoke must not seed before GitHub App verification succeeds");
      },
    });
    const payload = JSON.parse(writes.join(""));

    expect(code).toBe(1);
    expect(requests).toEqual(["http://api.local/internal/orchestrator/github-app/verify"]);
    expect(payload).toEqual({
      ok: false,
      stage: "readiness",
      error: "github_app_permissions_insufficient",
      diagnostics: {
        failedStage: "readiness",
        detail: "GitHub App installation or repository permissions are not ready for Codex E2B smoke.",
      },
      githubApp: {
        ok: false,
        status: 403,
        error: "github_app_permissions_insufficient",
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        missingPermissions: ["contents:write"],
      },
    });
    expect(JSON.stringify(payload)).not.toContain("github-app-private-key");
    expect(JSON.stringify(payload)).not.toContain("codex-secret");
    expect(JSON.stringify(payload)).not.toContain("service-secret");
  });

  test("defaults E2B smoke service-token auth to the compose stack token", async () => {
    const requests: Array<{ readonly url: string; readonly serviceToken: string | null }> = [];
    const code = await runE2BSmokeCli(["--api-url", "http://api.local", "--timeout-ms", "1000"], {
      env: {
        AUTH_MODE: "test",
        E2B_API_KEY: "e2b-secret",
        E2B_TEMPLATE_ID: "template-1",
        E2B_ALLOWED_SECRET_ENV_NAMES: "GITHUB_TOKEN",
        GITHUB_TOKEN: "github-secret",
      },
      write: () => {},
      fetch: async (input, init) => {
        requests.push({
          url: String(input),
          serviceToken: new Headers(init?.headers).get("x-agent-pool-service-token"),
        });

        if (String(input).endsWith("/internal/smoke/seed")) {
          return Response.json({ ok: true });
        }

        return Response.json({
          ok: true,
          finalResponse: { recorded: true },
          completion: { completed: true },
          cleanup: { completed: true },
        });
      },
    });

    expect(code).toBe(0);
    expect(requests).toEqual([
      { url: "http://api.local/internal/smoke/seed", serviceToken: "compose-internal-service-token" },
      { url: "http://api.local/internal/smoke/status", serviceToken: "compose-internal-service-token" },
    ]);
  });

  test("parses E2B smoke flags for local execution", () => {
    expect(
      parseE2BSmokeArgs([
        "--plan",
        "--doctor",
        "--api-url",
        "http://api.local",
        "--service-token",
        "token",
        "--timeout-ms",
        "5000",
        "--repository-url",
        "https://github.com/example/tiny-fixture.git",
        "--base-ref",
        "feature/ref",
        "--task-branch-prefix",
        "agent-pool/task",
        "--verify-callback",
        "--callback-timeout-ms",
        "250",
        "--evidence",
        "--validate-evidence",
        "evidence.json",
      ]),
    ).toEqual({
      dryRun: true,
      readiness: false,
      doctor: true,
      apiUrl: "http://api.local",
      serviceToken: "token",
      timeoutMs: 5000,
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      baseRef: "feature/ref",
      taskBranchPrefix: "agent-pool/task",
      maliciousFixtures: false,
      verifyCallback: true,
      callbackTimeoutMs: 250,
      evidence: true,
      validateEvidencePath: "evidence.json",
    });

    expect(
      createE2BSmokePlan({
        env: {
          AUTH_MODE: "test",
          E2B_TEMPLATE_ID: "template-1",
        },
      }).cleanup,
    ).toMatchObject({ provider: "e2b", timeoutMs: 30_000 });
  });

  test("lets explicit process env override local .env values", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-pool-env-override-"));
    await writeFile(join(cwd, ".env"), "RUNTIME_PROVIDER=fake\nE2B_TEMPLATE_ID=from-file\n");

    await expect(loadLocalEnv({ cwd, env: { RUNTIME_PROVIDER: "e2b" } })).resolves.toMatchObject({
      RUNTIME_PROVIDER: "e2b",
      E2B_TEMPLATE_ID: "from-file",
    });
  });
});
