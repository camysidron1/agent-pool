import { describe, expect, test } from "bun:test";

import {
  bridgeSessionFromSandboxEnv,
  buildSandboxBridgeStartupCommand,
  createSandboxBridgeStartupEnv,
  redactSandboxBridgeStartupEnv,
} from "../src";

describe("sandbox bridge startup contract", () => {
  test("builds env and command shape without token argv leakage", () => {
    const command = buildSandboxBridgeStartupCommand({
      workspaceRoot: "/workspace/agent-pool",
      session: {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        callbackBaseUrl: "https://api.internal.test",
        sessionToken: {
          headerName: "X-Agent-Pool-Session-Token",
          token: "session-secret",
        },
      },
    });

    expect(command.command).toEqual([
      "sh",
      "-lc",
      "nohup bun run '/workspace/agent-pool/packages/session-bridge/src/sandbox-entry.ts' > /tmp/agent-pool-session-bridge.log 2>&1 &",
    ]);
    expect(command.env).toEqual({
      AGENT_POOL_PROJECT_ID: "project_a",
      AGENT_POOL_TASK_ID: "task_1",
      AGENT_POOL_SESSION_ID: "session_1",
      AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "https://api.internal.test",
      AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
      AGENT_POOL_BRIDGE_SESSION_TOKEN: "session-secret",
      AGENT_POOL_WORKSPACE_ROOT: "/workspace/agent-pool",
    });
    expect(JSON.stringify(command.command)).not.toContain("session-secret");
    expect(redactSandboxBridgeStartupEnv(command.env).AGENT_POOL_BRIDGE_SESSION_TOKEN).toBe("[REDACTED]");
  });

  test("rejects unsafe sandbox bridge startup entrypoints", () => {
    expect(() =>
      buildSandboxBridgeStartupCommand({
        workspaceRoot: "/workspace/agent-pool",
        entrypoint: "../escape.ts",
        session: {
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          callbackBaseUrl: "https://api.internal.test",
          sessionToken: {
            headerName: "X-Agent-Pool-Session-Token",
            token: "session-secret",
          },
        },
      }),
    ).toThrow("sandbox bridge startup entrypoint is invalid");
  });

  test("reconstructs bridge session from env and rejects missing tokens", () => {
    const env = createSandboxBridgeStartupEnv(
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        callbackBaseUrl: "https://api.internal.test",
        sessionToken: {
          headerName: "x-agent-pool-session-token",
          token: "session-secret",
        },
      },
      "/workspace/agent-pool",
    );

    expect(bridgeSessionFromSandboxEnv(env)).toEqual({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      callbackBaseUrl: "https://api.internal.test",
      sessionToken: {
        headerName: "x-agent-pool-session-token",
        token: "session-secret",
      },
      workspaceRoot: "/workspace/agent-pool",
    });
    expect(() => bridgeSessionFromSandboxEnv({ ...env, AGENT_POOL_BRIDGE_SESSION_TOKEN: "" })).toThrow(
      "sandbox bridge startup requires AGENT_POOL_BRIDGE_SESSION_TOKEN",
    );
  });
});
