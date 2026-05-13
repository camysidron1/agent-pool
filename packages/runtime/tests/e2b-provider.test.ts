import { describe, expect, test } from "bun:test";

import {
  createE2BRuntimeProvider,
  type E2BCommandResult,
  type E2BCommandRunOptions,
  type E2BRuntimeClient,
  type E2BRuntimeProviderConfig,
  type E2BSandboxCreateInput,
  type RuntimeSessionRequest,
} from "../src";

type E2BClientCall =
  | {
      readonly kind: "create";
      readonly input: E2BSandboxCreateInput;
    }
  | {
      readonly kind: "command";
      readonly sandboxId: string;
      readonly command: readonly string[];
      readonly options: E2BCommandRunOptions;
    }
  | {
      readonly kind: "destroy";
      readonly sandboxId: string;
    };

const config: E2BRuntimeProviderConfig = {
  apiKeyEnvName: "E2B_API_KEY",
  apiKeyConfigured: true,
  templateId: "template-1",
  sandboxImageId: null,
  workingDirectory: "/workspace/agent-pool",
  startupTimeoutMs: 90_000,
  cleanupTimeoutMs: 45_000,
  githubTokenEnvName: "GITHUB_TOKEN",
  githubTokenConfigured: true,
  allowedSecretEnvNames: ["GITHUB_TOKEN"],
};

const request: RuntimeSessionRequest = {
  projectId: "project_a",
  taskId: "task_1",
  sessionId: "session_1",
  task: {
    runtimeSource: {
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      baseRef: "main",
      taskBranchPrefix: "agent-pool/task",
    },
  },
  bridge: {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "https://api.internal.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "session-secret",
    },
  },
};

describe("E2B runtime provider", () => {
  test("creates a sandbox, bootstraps the repository, starts the bridge, and returns redacted metadata", async () => {
    const { client, calls } = createRecordingClient();
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: {
        GITHUB_TOKEN: "github-secret",
        UNRELATED_SECRET: "must-not-project",
      },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const handle = await provider.startSession(request);
    const commandCalls = calls.filter(isCommandCall);
    const createCall = calls.find(isCreateCall);

    expect(handle).toMatchObject({
      provider: "e2b",
      sessionId: "sandbox_1",
      projectId: "project_a",
      taskId: "task_1",
      workspaceRoot: "/workspace/agent-pool",
      metadata: {
        sandboxId: "sandbox_1",
        branchName: "agent-pool/task/task_1",
        bootstrapCommands: 3,
        bridgeCommandAccepted: true,
      },
    });
    expect(createCall?.input.redactedLaunchSpec.environment.secrets).toEqual({ GITHUB_TOKEN: "[REDACTED]" });
    expect(commandCalls).toHaveLength(4);
    expect(commandCalls.map((call) => call.command[0])).toEqual(["git", "git", "git", "bun"]);
    expect(commandCalls[0]?.options.env).toMatchObject({
      GIT_TERMINAL_PROMPT: "0",
      AGENT_POOL_GITHUB_TOKEN_ENV: "GITHUB_TOKEN",
      GITHUB_TOKEN: "github-secret",
    });
    expect(commandCalls[3]?.options.env).toMatchObject({
      AGENT_POOL_BRIDGE_SESSION_TOKEN: "session-secret",
      AGENT_POOL_WORKSPACE_ROOT: "/workspace/agent-pool",
    });
    for (const commandCall of commandCalls) {
      expect(JSON.stringify(commandCall.command)).not.toContain("github-secret");
      expect(JSON.stringify(commandCall.command)).not.toContain("session-secret");
    }
    expect(JSON.stringify(handle.metadata)).not.toContain("github-secret");
    expect(JSON.stringify(handle.metadata)).not.toContain("session-secret");
    expect(JSON.stringify(handle.metadata)).not.toContain("must-not-project");
  });

  test("rejects missing runtime source or GitHub credentials before creating a sandbox", async () => {
    const missingSourceClient = createRecordingClient();
    const missingSourceProvider = createE2BRuntimeProvider({
      client: missingSourceClient.client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });
    const missingTokenClient = createRecordingClient();
    const missingTokenProvider = createE2BRuntimeProvider({
      client: missingTokenClient.client,
      config: { ...config, githubTokenConfigured: false },
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    await expect(missingSourceProvider.startSession({ ...request, task: {} })).rejects.toThrow(
      "github bootstrap requires runtime source metadata",
    );
    await expect(missingTokenProvider.startSession(request)).rejects.toThrow("GITHUB_TOKEN is required for github bootstrap");
    expect(missingSourceClient.calls).toEqual([]);
    expect(missingTokenClient.calls).toEqual([]);
  });

  test("redacts sandbox creation failures", async () => {
    const { client } = createRecordingClient({
      createSandbox: async () => {
        throw new Error("create failed with github-secret and session-secret");
      },
    });
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const message = await rejectedMessage(provider.startSession(request));

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("github-secret");
    expect(message).not.toContain("session-secret");
  });

  test("surfaces command failures deterministically and destroys the sandbox", async () => {
    const { client, calls } = createRecordingClient({
      runCommand: async () => ({
        ok: false,
        exitCode: 128,
        stderr: "clone failed for github-secret",
      }),
    });
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const message = await rejectedMessage(provider.startSession(request));

    expect(message).toContain("e2b command failed (clone repository, exit 128)");
    expect(message).not.toContain("github-secret");
    expect(calls.some((call) => call.kind === "destroy" && call.sandboxId === "sandbox_1")).toBe(true);
  });

  test("redacts timeout errors from the client boundary", async () => {
    const { client } = createRecordingClient({
      runCommand: async () => {
        throw new Error("startup timed out after seeing github-secret");
      },
    });
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const message = await rejectedMessage(provider.startSession(request));

    expect(message).toContain("startup timed out");
    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("github-secret");
  });
});

function createRecordingClient(overrides: {
  readonly createSandbox?: (input: E2BSandboxCreateInput) => Promise<{ readonly sandboxId: string }>;
  readonly runCommand?: (
    sandboxId: string,
    command: readonly string[],
    options: E2BCommandRunOptions,
  ) => Promise<E2BCommandResult>;
} = {}): { readonly client: E2BRuntimeClient; readonly calls: readonly E2BClientCall[] } {
  const calls: E2BClientCall[] = [];
  const client: E2BRuntimeClient = {
    async createSandbox(input) {
      calls.push({ kind: "create", input });
      return overrides.createSandbox?.(input) ?? { sandboxId: "sandbox_1" };
    },
    async runCommand(sandboxId, command, options) {
      calls.push({ kind: "command", sandboxId, command, options });
      return overrides.runCommand?.(sandboxId, command, options) ?? { ok: true, exitCode: 0 };
    },
    async destroySandbox(sandboxId) {
      calls.push({ kind: "destroy", sandboxId });
    },
  };

  return { client, calls };
}

function isCreateCall(call: E2BClientCall): call is Extract<E2BClientCall, { readonly kind: "create" }> {
  return call.kind === "create";
}

function isCommandCall(call: E2BClientCall): call is Extract<E2BClientCall, { readonly kind: "command" }> {
  return call.kind === "command";
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected promise to reject");
}
