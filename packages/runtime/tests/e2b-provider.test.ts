import { describe, expect, test } from "bun:test";

import {
  AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_DIGEST,
  createE2BRuntimeProvider,
  type E2BCommandResult,
  type E2BCommandRunOptions,
  type E2BCreateSnapshotOptions,
  type E2BDeleteSnapshotOptions,
  type E2BDestroySandboxOptions,
  type E2BRuntimeClient,
  type E2BRuntimeProviderConfig,
  type E2BSandboxCreateInput,
  type RuntimeLifecycleLogEvent,
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
      readonly options?: E2BDestroySandboxOptions;
    }
  | {
      readonly kind: "snapshot";
      readonly sandboxId: string;
      readonly options?: E2BCreateSnapshotOptions;
    }
  | {
      readonly kind: "deleteSnapshot";
      readonly snapshotId: string;
      readonly options?: E2BDeleteSnapshotOptions;
    };

const config: E2BRuntimeProviderConfig = {
  apiKeyEnvName: "E2B_API_KEY",
  apiKeyConfigured: true,
  templateId: "template-1",
  sandboxImageId: null,
  templateCompatibilityDigest: AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_DIGEST,
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
    expect(commandCalls.map((call) => call.command[0])).toEqual(["sh", "git", "git", "sh"]);
    expect(commandCalls[3]?.command).toEqual([
      "sh",
      "-lc",
      "nohup bun run '/agent-pool/session-bridge/src/sandbox-entry.ts' > /tmp/agent-pool-session-bridge.log 2>&1 &",
    ]);
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

  test("emits structured redacted lifecycle logs for sandbox startup commands and cleanup", async () => {
    const { client } = createRecordingClient();
    const events: RuntimeLifecycleLogEvent[] = [];
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: {
        GITHUB_TOKEN: "github-secret",
      },
      secretEnvNames: ["GITHUB_TOKEN"],
      logger: (event) => {
        events.push(event);
      },
    });

    const handle = await provider.startSession(request);
    await provider.stopSession(handle);

    expect(events.map((event) => event.event)).toEqual([
      "runtime.sandbox.starting",
      "runtime.sandbox.created",
      "runtime.command.started",
      "runtime.command.succeeded",
      "runtime.command.started",
      "runtime.command.succeeded",
      "runtime.command.started",
      "runtime.command.succeeded",
      "runtime.command.started",
      "runtime.command.succeeded",
      "runtime.sandbox.started",
      "runtime.sandbox.cleanup.started",
      "runtime.sandbox.cleanup.succeeded",
    ]);
    expect(events.find((event) => event.event === "runtime.command.started")).toMatchObject({
      provider: "e2b",
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      sandboxId: "sandbox_1",
      commandLabel: "prepare repository",
      command: [
        "sh",
        "-lc",
        expect.stringContaining("git clone --no-checkout https://github.com/example/tiny-fixture.git /workspace/agent-pool"),
      ],
    });
    expect(events.find((event) => event.event === "runtime.sandbox.cleanup.succeeded")).toMatchObject({
      provider: "e2b",
      sessionId: "session_1",
      sandboxId: "sandbox_1",
    });
    expect(JSON.stringify(events)).not.toContain("github-secret");
    expect(JSON.stringify(events)).not.toContain("session-secret");
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
      env: {},
      secretEnvNames: [],
    });

    await expect(missingSourceProvider.startSession({ ...request, task: {} })).rejects.toThrow(
      "github bootstrap requires runtime source metadata",
    );
    await expect(missingTokenProvider.startSession(request)).rejects.toThrow("GITHUB_TOKEN is required for github bootstrap");
    expect(missingSourceClient.calls).toEqual([]);
    expect(missingTokenClient.calls).toEqual([]);
  });

  test("rejects missing or stale template compatibility metadata before creating a sandbox", async () => {
    const missingTemplateClient = createRecordingClient();
    const missingTemplateProvider = createE2BRuntimeProvider({
      client: missingTemplateClient.client,
      config: { ...config, templateCompatibilityDigest: null },
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });
    const staleTemplateClient = createRecordingClient();
    const staleTemplateProvider = createE2BRuntimeProvider({
      client: staleTemplateClient.client,
      config: { ...config, templateCompatibilityDigest: "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" },
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    await expect(missingTemplateProvider.startSession(request)).rejects.toThrow("E2B template compatibility manifest or digest is missing");
    await expect(staleTemplateProvider.startSession(request)).rejects.toThrow("E2B template compatibility digest");
    expect(missingTemplateClient.calls).toEqual([]);
    expect(staleTemplateClient.calls).toEqual([]);
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

    expect(message).toContain("e2b command failed (prepare repository, exit 128)");
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

  test("redacts bootstrap-only GitHub tokens when they are not projected into the launch spec", async () => {
    const { client } = createRecordingClient({
      runCommand: async () => {
        throw new Error("bootstrap failed with github-secret");
      },
    });
    const provider = createE2BRuntimeProvider({
      client,
      config: { ...config, allowedSecretEnvNames: [] },
      env: { GITHUB_TOKEN: "github-secret" },
    });

    const message = await rejectedMessage(provider.startSession(request));

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("github-secret");
  });

  test("destroys E2B sandboxes once with the configured cleanup deadline", async () => {
    const { client, calls } = createRecordingClient();
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });
    const handle = {
      provider: "e2b" as const,
      sessionId: "runtime_session_1",
      metadata: {
        sandboxId: "sandbox_from_metadata",
      },
    };

    await provider.stopSession(handle);
    await provider.stopSession(handle);

    const destroyCalls = calls.filter(isDestroyCall);
    expect(destroyCalls).toEqual([
      {
        kind: "destroy",
        sandboxId: "sandbox_from_metadata",
        options: { timeoutMs: 45_000 },
      },
    ]);
    expect(provider.capabilities).toEqual({
      start: true,
      stop: true,
      suspend: false,
      resume: false,
      fork: false,
      snapshot: true,
      deleteSnapshot: true,
      startFromSnapshot: true,
    });
    expect("suspendSession" in provider).toBe(false);
    expect("resumeSession" in provider).toBe(false);
    expect("forkSession" in provider).toBe(false);
  });

  test("rejects cleanup without a sandbox id before calling the client", async () => {
    const { client, calls } = createRecordingClient();
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    await expect(provider.stopSession({ provider: "e2b", sessionId: " " })).rejects.toThrow(
      "e2b cleanup requires sandbox id",
    );
    expect(calls).toEqual([]);
  });

  test("redacts cleanup errors and leaves failed cleanup retryable", async () => {
    const { client, calls } = createRecordingClient({
      destroySandbox: async () => {
        throw new Error("cleanup failed for github-secret");
      },
    });
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const message = await rejectedMessage(provider.stopSession({ provider: "e2b", sessionId: "sandbox_1" }));
    const retryMessage = await rejectedMessage(provider.stopSession({ provider: "e2b", sessionId: "sandbox_1" }));

    expect(message).toContain("[REDACTED]");
    expect(message).not.toContain("github-secret");
    expect(retryMessage).toContain("[REDACTED]");
    expect(calls.filter(isDestroyCall)).toHaveLength(2);
  });

  test("surfaces cleanup deadline failures from the client boundary", async () => {
    const { client } = createRecordingClient({
      destroySandbox: async (_sandboxId, options) => {
        throw new Error(`cleanup timed out after ${options?.timeoutMs ?? 0}ms`);
      },
    });
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    await expect(provider.stopSession({ provider: "e2b", sessionId: "sandbox_1" })).rejects.toThrow(
      "cleanup timed out after 45000ms",
    );
  });

  test("creates and deletes E2B snapshots through the client boundary", async () => {
    const { client, calls } = createRecordingClient();
    const provider = createE2BRuntimeProvider({
      client,
      config,
      env: { GITHUB_TOKEN: "github-secret" },
      secretEnvNames: ["GITHUB_TOKEN"],
    });

    const snapshot = await provider.createSnapshot({ provider: "e2b", sessionId: "sandbox_1" });
    await provider.deleteSnapshot(snapshot);

    expect(snapshot).toMatchObject({
      provider: "e2b",
      snapshotId: "snapshot_1",
      sourceSessionId: "sandbox_1",
    });
    expect(calls.filter((call) => call.kind === "snapshot")).toEqual([
      { kind: "snapshot", sandboxId: "sandbox_1", options: { timeoutMs: 45_000 } },
    ]);
    expect(calls.filter((call) => call.kind === "deleteSnapshot")).toEqual([
      { kind: "deleteSnapshot", snapshotId: "snapshot_1", options: { timeoutMs: 45_000 } },
    ]);
  });
});

function createRecordingClient(overrides: {
  readonly createSandbox?: (input: E2BSandboxCreateInput) => Promise<{ readonly sandboxId: string }>;
  readonly runCommand?: (
    sandboxId: string,
    command: readonly string[],
    options: E2BCommandRunOptions,
  ) => Promise<E2BCommandResult>;
  readonly destroySandbox?: (sandboxId: string, options?: E2BDestroySandboxOptions) => Promise<void>;
  readonly createSnapshot?: (sandboxId: string, options?: E2BCreateSnapshotOptions) => Promise<{ readonly snapshotId: string }>;
  readonly deleteSnapshot?: (snapshotId: string, options?: E2BDeleteSnapshotOptions) => Promise<void>;
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
    async destroySandbox(sandboxId, options) {
      calls.push({ kind: "destroy", sandboxId, options });
      await overrides.destroySandbox?.(sandboxId, options);
    },
    async createSnapshot(sandboxId, options) {
      calls.push({ kind: "snapshot", sandboxId, options });
      return overrides.createSnapshot?.(sandboxId, options) ?? { snapshotId: "snapshot_1" };
    },
    async deleteSnapshot(snapshotId, options) {
      calls.push({ kind: "deleteSnapshot", snapshotId, options });
      await overrides.deleteSnapshot?.(snapshotId, options);
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

function isDestroyCall(call: E2BClientCall): call is Extract<E2BClientCall, { readonly kind: "destroy" }> {
  return call.kind === "destroy";
}

async function rejectedMessage(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }

  throw new Error("expected promise to reject");
}
