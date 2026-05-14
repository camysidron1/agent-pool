import { describe, expect, test } from "bun:test";

import { createTestBridgeCallbackServer } from "../src";
import { runSandboxBridgeEntry } from "../src/sandbox-entry";

describe("sandbox bridge entrypoint", () => {
  test("runs bridge callbacks from sandbox env without leaking session tokens", async () => {
    const env = sandboxEnv();
    const server = createTestBridgeCallbackServer({
      sessionToken: {
        headerName: env.AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER,
        token: env.AGENT_POOL_BRIDGE_SESSION_TOKEN,
      },
    });

    const result = await runSandboxBridgeEntry({
      env: {
        ...env,
        AGENT_POOL_BRIDGE_COMPLETION_DELAY_MS: "0",
      },
      fetch: server.fetch,
      sleep: async () => undefined,
    });

    expect(result).toMatchObject({
      ok: true,
      dryRun: false,
      session: {
        AGENT_POOL_BRIDGE_SESSION_TOKEN: "[REDACTED]",
      },
      firstPass: {
        heartbeatPosted: true,
        outputPosted: 1,
      },
      terminalPass: {
        finalResponsePosted: true,
        completionPosted: true,
        cleanupPosted: true,
      },
    });
    expect(server.events.map((event) => event.kind)).toEqual(["heartbeat", "output", "heartbeat", "final_response", "completion", "cleanup"]);
    expect(JSON.stringify(result)).not.toContain(env.AGENT_POOL_BRIDGE_SESSION_TOKEN);
  });

  test("supports dry-run env validation without posting callbacks", async () => {
    const env = sandboxEnv();
    const server = createTestBridgeCallbackServer({
      sessionToken: {
        headerName: env.AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER,
        token: env.AGENT_POOL_BRIDGE_SESSION_TOKEN,
      },
    });

    const result = await runSandboxBridgeEntry({
      env,
      fetch: server.fetch,
      args: ["--dry-run"],
    });

    expect(result).toMatchObject({
      ok: true,
      dryRun: true,
      session: {
        AGENT_POOL_BRIDGE_SESSION_TOKEN: "[REDACTED]",
      },
    });
    expect(server.events).toEqual([]);
  });
});

function sandboxEnv(): Record<string, string> {
  return {
    AGENT_POOL_PROJECT_ID: "project_a",
    AGENT_POOL_TASK_ID: "task_1",
    AGENT_POOL_SESSION_ID: "session_1",
    AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "http://callback.test",
    AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
    AGENT_POOL_BRIDGE_SESSION_TOKEN: "session-secret",
    AGENT_POOL_WORKSPACE_ROOT: "/workspace/agent-pool",
  };
}
