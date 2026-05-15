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

    expect(spec).toMatchObject({
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
      sourceSnapshot: null,
      environment: {
        variables: {
          AGENT_POOL_PROJECT_ID: "project_a",
          AGENT_POOL_TASK_ID: "task_1",
          AGENT_POOL_SESSION_ID: "session_1",
          AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "https://api.internal.test",
          AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
          AGENT_POOL_BRIDGE_RUNNER: "bridge-smoke",
          AGENT_POOL_CODEX_COMMAND: "codex",
          AGENT_POOL_CODEX_API_KEY_ENV_NAME: "CODEX_API_KEY",
          AGENT_POOL_CODEX_COMMAND_PROFILE: "agent-pool-bun-pr",
        },
        secrets: {
          GITHUB_TOKEN: "github-secret",
        },
      },
      runner: {
        mode: "bridge-smoke",
        codex: null,
      },
      network: {
        egressMode: "test-direct",
        allowInternetAccess: true,
        allowOut: [],
        allowPublicTraffic: false,
        proxyUrl: null,
        noProxy: null,
      },
    });
    expect(JSON.stringify(spec)).not.toContain("UNRELATED_SECRET");
  });

  test("maps provider source snapshots into the launch spec", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        bridge,
        sourceSnapshot: {
          id: "snapshot_record_1",
          provider: "e2b",
          providerSnapshotId: "snapshot_provider_1",
        },
      },
      { config },
    );

    expect(spec.sourceSnapshot).toEqual({
      id: "snapshot_record_1",
      providerSnapshotId: "snapshot_provider_1",
    });
  });

  test("builds strict codex runner launch specs with brokered GitHub and Codex secrets", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        task: {
          id: "task_1",
          title: "Make a PR",
          description: "Use the real runner",
          runtimeSource: {
            repositoryUrl: "https://github.com/example/tiny-fixture.git",
            baseRef: "main",
            taskBranchPrefix: "agent-pool/task",
            allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
            commandProfile: "agent-pool-bun-pr",
          },
        },
        bridge,
        secretEnvironment: {
          GITHUB_TOKEN: "short-lived-github-token",
        },
      },
      {
        config: {
          ...config,
          agentRunnerMode: "codex",
          allowedSecretEnvNames: ["GITHUB_TOKEN", "CODEX_API_KEY"],
          codexApiKeyEnvName: "CODEX_API_KEY",
          codexCommand: "codex",
          codexCommandProfile: "agent-pool-bun-pr",
          codexModel: "gpt-5.2",
          egressProxyUrl: "http://egress-gateway.internal:8080",
          egressProxyAllowOut: ["10.0.10.25/32"],
          egressProxyNoProxy: "127.0.0.1,localhost",
          allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
        },
        env: {
          CODEX_API_KEY: "codex-secret",
        },
      },
    );

    expect(spec.environment.secrets).toEqual({
      GITHUB_TOKEN: "short-lived-github-token",
      CODEX_API_KEY: "codex-secret",
    });
    expect(spec.environment.variables).toMatchObject({
      AGENT_POOL_BRIDGE_RUNNER: "codex",
      AGENT_POOL_CODEX_COMMAND: "codex",
      AGENT_POOL_CODEX_API_KEY_ENV_NAME: "CODEX_API_KEY",
      AGENT_POOL_CODEX_COMMAND_PROFILE: "agent-pool-bun-pr",
      AGENT_POOL_CODEX_MODEL: "gpt-5.2",
      AGENT_POOL_TASK_TITLE: "Make a PR",
      AGENT_POOL_TASK_DESCRIPTION: "Use the real runner",
      AGENT_POOL_REPOSITORY_URL: "https://github.com/example/tiny-fixture.git",
      AGENT_POOL_BASE_REF: "main",
      AGENT_POOL_TASK_BRANCH: "agent-pool/task/task_1",
      AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
      NO_PROXY: "127.0.0.1,localhost",
    });
    expect(spec.environment.variables.HTTP_PROXY).toMatch(/^http:\/\/[^:]+:session-secret@egress-gateway\.internal:8080\/$/);
    expect(spec.environment.variables.HTTPS_PROXY).toBe(spec.environment.variables.HTTP_PROXY);
    expect(spec.environment.variables.ALL_PROXY).toBe(spec.environment.variables.HTTP_PROXY);
    expect(spec.runner).toEqual({
      mode: "codex",
      codex: {
        command: "codex",
        apiKeyEnvName: "CODEX_API_KEY",
        model: "gpt-5.2",
        commandProfile: "agent-pool-bun-pr",
      },
    });
    expect(spec.network).toEqual({
      egressMode: "proxy",
      allowInternetAccess: false,
      allowOut: ["10.0.10.25/32"],
      allowPublicTraffic: false,
      proxyUrl: spec.environment.variables.HTTP_PROXY,
      noProxy: "127.0.0.1,localhost",
    });
    expect(JSON.stringify(redactE2BLaunchSpec(spec))).not.toContain("short-lived-github-token");
    expect(JSON.stringify(redactE2BLaunchSpec(spec))).not.toContain("codex-secret");
    expect(JSON.stringify(redactE2BLaunchSpec(spec))).not.toContain("session-secret");
  });

  test("supports explicit local direct egress for Codex E2B smoke runs", () => {
    const spec = buildE2BLaunchSpec(
      {
        projectId: "project_a",
        taskId: "task_1",
        task: {
          runtimeSource: {
            repositoryUrl: "https://github.com/example/tiny-fixture.git",
            baseRef: "main",
            taskBranchPrefix: "agent-pool/task",
            allowedEgressDomains: ["github.com", "api.github.com"],
            commandProfile: "agent-pool-bun-pr",
          },
        },
        bridge,
        secretEnvironment: {
          GITHUB_TOKEN: "short-lived-github-token",
        },
      },
      {
        config: {
          ...config,
          agentRunnerMode: "codex",
          allowedSecretEnvNames: ["GITHUB_TOKEN", "CODEX_API_KEY"],
          codexApiKeyEnvName: "CODEX_API_KEY",
          localAllowDirectEgress: true,
        },
        env: {
          CODEX_API_KEY: "codex-secret",
        },
      },
    );

    expect(spec.environment.variables).toMatchObject({
      AGENT_POOL_BRIDGE_RUNNER: "codex",
      AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com",
    });
    expect(spec.environment.variables).not.toHaveProperty("HTTP_PROXY");
    expect(spec.network).toEqual({
      egressMode: "test-direct",
      allowInternetAccess: true,
      allowOut: [],
      allowPublicTraffic: false,
      proxyUrl: null,
      noProxy: null,
    });
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

    expect(startup.command).toEqual([
      "sh",
      "-lc",
      "nohup bun run '/agent-pool/session-bridge/src/sandbox-entry.ts' > /tmp/agent-pool-session-bridge.log 2>&1 &",
    ]);
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
