import { describe, expect, test } from "bun:test";

import {
  createComposeSmokePlan,
  parseComposeSmokeArgs,
  runComposeSmokeCli,
} from "../../../deploy/compose/smoke-compose";

describe("compose smoke runner", () => {
  test("builds a bounded compose smoke plan without using the legacy TUI database", () => {
    const plan = createComposeSmokePlan({
      cwd: "/repo",
      projectName: "agent-pool-test",
      apiUrl: "http://api.local/",
      orchestratorUrl: "http://orchestrator.local/",
      timeoutMs: 42_000,
    });

    expect(plan.composeFile).toBe("/repo/deploy/compose/docker-compose.yml");
    expect(plan.projectName).toBe("agent-pool-test");
    expect(plan.apiUrl).toBe("http://api.local");
    expect(plan.orchestratorUrl).toBe("http://orchestrator.local");
    expect(plan.timeoutMs).toBe(42_000);
    expect(plan.commands.map((command) => command.command.join(" "))).toEqual([
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test up -d --wait",
      "docker compose -f /repo/deploy/compose/docker-compose.yml -p agent-pool-test down -v --remove-orphans",
    ]);
    expect(JSON.stringify(plan)).not.toContain(".agent-pool/data/agent-pool.db");
    expect(plan.readiness.map((endpoint) => endpoint.label)).toEqual([
      "api health",
      "orchestrator health",
      "rabbitmq management",
      "minio readiness",
      "prometheus health",
    ]);
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
      serviceToken: "token",
      timeoutMs: 5000,
      teardown: false,
    });
  });
});
