import { describe, expect, test } from "bun:test";

import {
  buildE2BLaunchSpec,
  buildSandboxBridgeStartupPlan,
  redactE2BLaunchSpec,
  type E2BRuntimeProviderConfig,
  type RuntimeBridgeSessionOptions,
} from "../src";

const bridge: RuntimeBridgeSessionOptions = {
  projectId: "project_a",
  taskId: "task_1",
  sessionId: "session_1",
  callbackBaseUrl: "https://api.internal.test",
  sessionToken: {
    headerName: "x-agent-pool-session-token",
    token: "session-secret",
  },
  workspaceRoot: "/workspace/agent-pool",
};

const config: E2BRuntimeProviderConfig = {
  apiKeyEnvName: "E2B_API_KEY",
  apiKeyConfigured: true,
  templateId: "template-1",
  sandboxImageId: null,
  workingDirectory: "/workspace/agent-pool/",
  startupTimeoutMs: 90_000,
  cleanupTimeoutMs: 45_000,
  githubTokenEnvName: "GITHUB_TOKEN",
  githubTokenConfigured: true,
  allowedSecretEnvNames: ["GITHUB_TOKEN"],
};

describe("E2B launch spec", () => {
  test("builds a deterministic launch spec with scoped secret projection", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        bridge,
      },
      {
        config,
        secretEnvNames: ["GITHUB_TOKEN"],
        env: {
          GITHUB_TOKEN: "github-secret",
          UNRELATED_SECRET: "must-not-project",
        },
      },
    );

    expect(spec).toEqual({
      provider: "e2b",
      sandbox: {
        templateId: "template-1",
        sandboxImageId: null,
        workingDirectory: "/workspace/agent-pool",
        startupTimeoutMs: 90_000,
        cleanupTimeoutMs: 45_000,
      },
      session: {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
      },
      bridge,
      environment: {
        variables: {
          AGENT_POOL_PROJECT_ID: "project_a",
          AGENT_POOL_TASK_ID: "task_1",
          AGENT_POOL_SESSION_ID: "session_1",
          AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "https://api.internal.test",
          AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
        },
        secrets: {
          GITHUB_TOKEN: "github-secret",
        },
      },
    });
    expect(JSON.stringify(spec)).not.toContain("UNRELATED_SECRET");
  });

  test("redacts session and scoped secret values from snapshots", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        bridge,
      },
      {
        config,
        env: {
          GITHUB_TOKEN: "github-secret",
        },
      },
    );
    const redacted = redactE2BLaunchSpec(spec);

    expect(redacted.bridge.sessionToken.token).toBe("[REDACTED]");
    expect(redacted.environment.secrets).toEqual({ GITHUB_TOKEN: "[REDACTED]" });
    expect(JSON.stringify(redacted)).not.toContain("github-secret");
    expect(JSON.stringify(redacted)).not.toContain("session-secret");
  });

  test("builds sandbox bridge startup command without token arguments", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        bridge,
      },
      { config },
    );
    const startup = buildSandboxBridgeStartupPlan(spec);

    expect(startup.command).toEqual(["bun", "run", "/workspace/agent-pool/packages/session-bridge/src/sandbox-entry.ts"]);
    expect(startup.env).toMatchObject({
      AGENT_POOL_PROJECT_ID: "project_a",
      AGENT_POOL_TASK_ID: "task_1",
      AGENT_POOL_SESSION_ID: "session_1",
      AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "https://api.internal.test",
      AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
      AGENT_POOL_BRIDGE_SESSION_TOKEN: "session-secret",
      AGENT_POOL_WORKSPACE_ROOT: "/workspace/agent-pool",
    });
    expect(startup.redactedEnv.AGENT_POOL_BRIDGE_SESSION_TOKEN).toBe("[REDACTED]");
    expect(JSON.stringify(startup.command)).not.toContain("session-secret");
    expect(JSON.stringify(startup.redactedEnv)).not.toContain("session-secret");
  });

  test("rejects invalid launch specs before provider calls", () => {
    expect(() => buildE2BLaunchSpec({ projectId: "project_a", taskId: "task_1" }, { config })).toThrow(
      "e2b launch spec requires bridge session options",
    );
    expect(() =>
      buildE2BLaunchSpec(
        {
          projectId: "project_a",
          taskId: "task_1",
          bridge,
        },
        { config: { ...config, templateId: null, sandboxImageId: null } },
      ),
    ).toThrow("e2b launch spec requires E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID");
    expect(() =>
      buildE2BLaunchSpec(
        {
          projectId: "project_a",
          taskId: "task_1",
          bridge,
        },
        { config, secretEnvNames: ["UNSCOPED_SECRET"], env: { UNSCOPED_SECRET: "secret" } },
      ),
    ).toThrow("e2b launch spec rejected unscoped secret env var");
    expect(() =>
      buildE2BLaunchSpec(
        {
          projectId: "project_a",
          taskId: "task_1",
          bridge,
        },
        { config: { ...config, workingDirectory: "/Users/camysidron/.agent-pool/data/agent-pool.db" } },
      ),
    ).toThrow("host paths or the TUI database");
  });
});
