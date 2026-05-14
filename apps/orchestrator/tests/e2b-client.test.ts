import { describe, expect, test } from "bun:test";

import { buildE2BLaunchSpec, redactE2BLaunchSpec, type E2BSandboxCreateInput } from "@agent-pool/runtime";

import { createE2BRuntimeClient, serializeE2BCommand, type E2BSdkLoader } from "../src/e2b-client";

describe("E2B SDK runtime client", () => {
  test("creates a sandbox with template scoped env and non-secret metadata", async () => {
    const calls: E2BSdkCall[] = [];
    const client = createE2BRuntimeClient({
      env: { CUSTOM_E2B_API_KEY: "e2b-api-secret" },
      apiKeyEnvName: "CUSTOM_E2B_API_KEY",
      loadSdk: createFakeE2BSdkLoader(calls),
    });

    const result = await client.createSandbox(sandboxInput());

    expect(result).toEqual({ sandboxId: "sandbox_1" });
    expect(calls).toEqual([
      {
        kind: "create",
        template: "template-1",
        options: {
          apiKey: "e2b-api-secret",
          envs: {
            AGENT_POOL_PROJECT_ID: "project_a",
            AGENT_POOL_TASK_ID: "task_1",
            AGENT_POOL_SESSION_ID: "session_1",
            AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: "https://console.agentpool.app",
            AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: "x-agent-pool-session-token",
          },
          metadata: {
            agentPoolProjectId: "project_a",
            agentPoolTaskId: "task_1",
            agentPoolSessionId: "session_1",
          },
          requestTimeoutMs: 120_000,
          secure: true,
          allowInternetAccess: true,
        },
      },
    ]);
  });

  test("runs argv through E2B command shell with command-scoped environment", async () => {
    const calls: E2BSdkCall[] = [];
    const client = createE2BRuntimeClient({
      env: { E2B_API_KEY: "e2b-api-secret" },
      loadSdk: createFakeE2BSdkLoader(calls),
    });

    await client.createSandbox(sandboxInput());
    const result = await client.runCommand("sandbox_1", ["echo", "hello world"], {
      env: { GITHUB_TOKEN: "github-secret" },
      timeoutMs: 5_000,
    });

    expect(result).toEqual({ ok: true, exitCode: 0, stdout: "ok" });
    expect(calls.at(-1)).toEqual({
      kind: "run",
      sandboxId: "sandbox_1",
      command: "echo 'hello world'",
      options: {
        envs: { GITHUB_TOKEN: "github-secret" },
        timeoutMs: 5_000,
        requestTimeoutMs: 5_000,
        onStdout: expect.any(Function),
        onStderr: expect.any(Function),
      },
    });
  });

  test("maps SDK command exit errors into runtime command failures", async () => {
    const calls: E2BSdkCall[] = [];
    const client = createE2BRuntimeClient({
      env: { E2B_API_KEY: "e2b-api-secret" },
      loadSdk: createFakeE2BSdkLoader(calls, {
        run: async () => {
          throw Object.assign(new Error("command failed"), {
            exitCode: 128,
            stdout: "out",
            stderr: "err",
          });
        },
      }),
    });

    await client.createSandbox(sandboxInput());

    await expect(client.runCommand("sandbox_1", ["git", "fetch"], {})).resolves.toEqual({
      ok: false,
      exitCode: 128,
      stdout: "out",
      stderr: "err",
    });
  });

  test("destroys cached and reconnectable sandboxes without exposing the API key in command args", async () => {
    const calls: E2BSdkCall[] = [];
    const client = createE2BRuntimeClient({
      env: { E2B_API_KEY: "e2b-api-secret" },
      loadSdk: createFakeE2BSdkLoader(calls),
    });

    await client.createSandbox(sandboxInput());
    await client.destroySandbox("sandbox_1", { timeoutMs: 30_000 });
    await client.destroySandbox("sandbox_missing", { timeoutMs: 30_000 });

    expect(calls.filter((call) => call.kind === "kill" || call.kind === "staticKill")).toEqual([
      { kind: "kill", sandboxId: "sandbox_1", options: { requestTimeoutMs: 30_000 } },
      {
        kind: "staticKill",
        sandboxId: "sandbox_missing",
        options: { apiKey: "e2b-api-secret", requestTimeoutMs: 30_000 },
      },
    ]);
    expect(JSON.stringify(calls.filter((call) => call.kind === "run"))).not.toContain("e2b-api-secret");
  });

  test("shell quotes argv segments without allowing empty or NUL commands", () => {
    expect(serializeE2BCommand(["bash", "-lc", "printf '%s' \"hello world\""])).toBe(
      "bash -lc 'printf '\\''%s'\\'' \"hello world\"'",
    );
    expect(serializeE2BCommand(["echo", ""])).toBe("echo ''");
    expect(() => serializeE2BCommand([])).toThrow("e2b command requires at least one argv segment");
    expect(() => serializeE2BCommand(["echo", "bad\0arg"])).toThrow("e2b command argv segment must not contain NUL bytes");
  });
});

type E2BSdkCall =
  | {
      readonly kind: "create";
      readonly template: string;
      readonly options: Record<string, unknown>;
    }
  | {
      readonly kind: "connect";
      readonly sandboxId: string;
      readonly options: Record<string, unknown>;
    }
  | {
      readonly kind: "run";
      readonly sandboxId: string;
      readonly command: string;
      readonly options: Record<string, unknown>;
    }
  | {
      readonly kind: "kill";
      readonly sandboxId: string;
      readonly options: Record<string, unknown>;
    }
  | {
      readonly kind: "staticKill";
      readonly sandboxId: string;
      readonly options: Record<string, unknown>;
    };

function createFakeE2BSdkLoader(
  calls: E2BSdkCall[],
  overrides: {
    readonly run?: (command: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  } = {},
): E2BSdkLoader {
  return async () => ({
    Sandbox: {
      async create(template, options) {
        calls.push({ kind: "create", template, options: options ?? {} });
        return createSandbox("sandbox_1", calls, overrides);
      },
      async connect(sandboxId, options) {
        calls.push({ kind: "connect", sandboxId, options: options ?? {} });
        return createSandbox(sandboxId, calls, overrides);
      },
      async kill(sandboxId, options) {
        calls.push({ kind: "staticKill", sandboxId, options: options ?? {} });
        return true;
      },
    },
  });
}

function createSandbox(
  sandboxId: string,
  calls: E2BSdkCall[],
  overrides: {
    readonly run?: (command: string, options?: Record<string, unknown>) => Promise<Record<string, unknown>>;
  },
) {
  return {
    sandboxId,
    commands: {
      async run(command: string, options?: Record<string, unknown>) {
        calls.push({ kind: "run", sandboxId, command, options: options ?? {} });
        return overrides.run?.(command, options) ?? { exitCode: 0, stdout: "ok", stderr: "" };
      },
    },
    async kill(options?: Record<string, unknown>) {
      calls.push({ kind: "kill", sandboxId, options: options ?? {} });
    },
  };
}

function sandboxInput(): E2BSandboxCreateInput {
  const launchSpec = buildE2BLaunchSpec(
    {
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      bridge: {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        callbackBaseUrl: "https://console.agentpool.app",
        sessionToken: {
          headerName: "x-agent-pool-session-token",
          token: "bridge-token",
        },
        workspaceRoot: "/workspace/agent-pool",
      },
    },
    {
      config: {
        apiKeyEnvName: "E2B_API_KEY",
        apiKeyConfigured: true,
        templateId: "template-1",
        workingDirectory: "/workspace/agent-pool",
        startupTimeoutMs: 120_000,
        cleanupTimeoutMs: 30_000,
        githubTokenEnvName: "GITHUB_TOKEN",
        githubTokenConfigured: true,
        allowedSecretEnvNames: ["GITHUB_TOKEN"],
      },
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    },
  );

  return {
    launchSpec,
    redactedLaunchSpec: redactE2BLaunchSpec(launchSpec),
  };
}
