import { describe, expect, test } from "bun:test";

import { createRabbitMqAdapter } from "@agent-pool/queue";
import {
  createFakeRuntimeProvider,
  type E2BCommandResult,
  type E2BCommandRunOptions,
  type E2BRuntimeClient,
  type E2BSandboxCreateInput,
} from "@agent-pool/runtime";

import { loadConfig } from "@agent-pool/config";
import type { TaskQueueConsumerBackend } from "../src/task-consumer";
import { runTaskQueueConsumerOnce } from "../src/task-consumer";
import { createRuntimeStarter } from "../src/runtime-starter";

describe("orchestrator runtime starter", () => {
  test("starts fake runtime from claimed task session and bridge config", async () => {
    const provider = createFakeRuntimeProvider({
      sessionIdFactory: () => "runtime_fake_1",
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
    });
    const starter = createRuntimeStarter({ provider, workspaceRoot: "/tmp/fake-workspace" });
    const result = await starter({
      projectId: "project_a",
      task: { id: "task_1", title: "Run fake" },
      session: {
        id: "session_1",
        bridge: bridgeConfig(),
      },
      wakeup: { taskId: "task_1" },
    });

    expect(result).toEqual({ ok: true, runtimeSessionId: "runtime_fake_1" });
    expect(provider.state.started).toHaveLength(1);
    expect(provider.state.started[0]?.request).toMatchObject({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      workspaceRoot: "/tmp/fake-workspace",
      bridge: {
        callbackBaseUrl: "http://api.test",
        sessionToken: { headerName: "x-agent-pool-session-token", token: "bridge-token" },
      },
    });
  });

  test("reports deterministic fake startup failures as startup result failures", async () => {
    const starter = createRuntimeStarter({
      fake: {
        scenario: {
          startup: "failure",
          startupErrorMessage: "fake startup failed",
        },
      },
    });

    await expect(
      starter({
        projectId: "project_a",
        task: { id: "task_1" },
        session: { id: "session_1", bridge: bridgeConfig() },
        wakeup: {},
      }),
    ).resolves.toEqual({ ok: false, errorMessage: "fake startup failed" });
  });

  test("mints short-lived GitHub tokens before required codex runtime startup", async () => {
    const provider = createFakeRuntimeProvider({
      sessionIdFactory: () => "runtime_fake_tokened",
    });
    const starter = createRuntimeStarter({
      provider,
      requiresGitHubTokenBroker: true,
      githubTokenBroker: {
        mintGitHubSessionToken: async (input) => ({
          ok: true,
          status: 200,
          body: {
            ok: true,
            token: {
              envName: "GITHUB_TOKEN",
              value: `short-lived-${input.sessionId}`,
              expiresAt: "2026-05-14T19:00:00.000Z",
              repositoryUrl: "https://github.com/example/tiny-fixture.git",
            },
          },
        }),
      },
    });

    const result = await starter({
      projectId: "project_a",
      task: { id: "task_1", runtimeSource: runtimeSource() },
      session: { id: "session_1", bridge: bridgeConfig() },
      wakeup: { taskId: "task_1" },
    });

    expect(result).toEqual({ ok: true, runtimeSessionId: "runtime_fake_tokened" });
    expect(provider.state.started[0]?.request.secretEnvironment).toEqual({
      GITHUB_TOKEN: "short-lived-session_1",
    });
  });

  test("starts E2B runtime from claimed task source and bridge config", async () => {
    const { client, calls } = createE2BClient();
    const starter = createRuntimeStarter({
      providerKind: "e2b",
      e2b: {
        client,
        config: e2bConfig(),
        env: { GITHUB_TOKEN: "github-secret" },
        secretEnvNames: ["GITHUB_TOKEN"],
      },
    });

    const result = await starter({
      projectId: "project_a",
      task: { id: "task_1", runtimeSource: runtimeSource() },
      session: { id: "session_1", bridge: bridgeConfig() },
      wakeup: { taskId: "task_1" },
    });

    const createCall = calls.find((call) => call.kind === "create");
    const commandCalls = calls.filter((call) => call.kind === "command");
    expect(result).toEqual({ ok: true, runtimeSessionId: "sandbox_1" });
    expect(createCall?.input.launchSpec).toMatchObject({
      sandbox: {
        templateId: "template-1",
        workingDirectory: "/workspace/agent-pool",
      },
      environment: {
        secrets: {
          GITHUB_TOKEN: "github-secret",
        },
      },
    });
    expect(commandCalls).toHaveLength(4);
    expect(commandCalls[0]?.options.env).toMatchObject({ GITHUB_TOKEN: "github-secret" });
    expect(JSON.stringify(createCall?.input.redactedLaunchSpec)).not.toContain("github-secret");
  });

  test("passes claimed source snapshots into E2B startup", async () => {
    const { client, calls } = createE2BClient();
    const starter = createRuntimeStarter({
      providerKind: "e2b",
      e2b: {
        client,
        config: e2bConfig(),
        env: { GITHUB_TOKEN: "github-secret" },
        secretEnvNames: ["GITHUB_TOKEN"],
      },
    });

    await starter({
      projectId: "project_a",
      task: { id: "task_1", runtimeSource: runtimeSource() },
      session: {
        id: "session_1",
        bridge: bridgeConfig(),
        sourceSnapshot: {
          id: "snapshot_record_1",
          provider: "e2b",
          providerSnapshotId: "provider_snapshot_1",
        },
      },
      wakeup: { taskId: "task_1", sourceSnapshotId: "snapshot_record_1" },
    });

    const createCall = calls.find((call) => call.kind === "create");
    expect(createCall?.input.launchSpec.sourceSnapshot).toEqual({
      id: "snapshot_record_1",
      providerSnapshotId: "provider_snapshot_1",
    });
  });

  test("task consumer reports fake runtime startup success through existing backend API path", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const provider = createFakeRuntimeProvider({ sessionIdFactory: () => "runtime_fake_consumer" });
    const reports: unknown[] = [];
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_1", title: "Run fake" },
          session: { id: "session_1", bridge: bridgeConfig() },
          event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
          outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "project.project_a.control" },
        },
      }),
      reportStartupSucceeded: async (input) => {
        reports.push(input);
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            idempotent: false,
            session: { id: input.sessionId },
            task: { id: "task_1" },
            event: null,
            outbox: null,
          },
        };
      },
      reportStartupFailed: async () => {
        throw new Error("startup failure report should not be called");
      },
    };

    queue.publishProjectTaskHint("project_a", { taskId: "task_1" });

    const result = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      runtimeProvider: "fake",
      runtimeStarter: createRuntimeStarter({ provider }),
    });

    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      claimed: 1,
      startupsSucceeded: 1,
      startupsFailed: 0,
    });
    expect(reports).toEqual([
      {
        projectId: "project_a",
        sessionId: "session_1",
        runtimeSessionId: "runtime_fake_consumer",
      },
    ]);
    expect(provider.state.started[0]?.request.session).toMatchObject({ id: "session_1", bridge: bridgeConfig() });
  });

  test("task consumer reports E2B startup failures through the existing backend API path", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const reports: unknown[] = [];
    const { client } = createE2BClient({
      runCommand: async () => ({
        ok: false,
        exitCode: 128,
        stderr: "clone failed with github-secret",
      }),
    });
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_1", title: "Run E2B", runtimeSource: runtimeSource() },
          session: { id: "session_1", bridge: bridgeConfig() },
          event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
          outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "project.project_a.control" },
        },
      }),
      reportStartupSucceeded: async () => {
        throw new Error("startup success report should not be called");
      },
      reportStartupFailed: async (input) => {
        reports.push(input);
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            idempotent: false,
            session: { id: input.sessionId },
            task: { id: "task_1" },
            event: null,
            outbox: null,
          },
        };
      },
    };

    queue.publishProjectTaskHint("project_a", { taskId: "task_1" });

    const result = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      runtimeProvider: "e2b",
      runtimeStarter: createRuntimeStarter({
        providerKind: "e2b",
        e2b: {
          client,
          config: e2bConfig(),
          env: { GITHUB_TOKEN: "github-secret" },
          secretEnvNames: ["GITHUB_TOKEN"],
        },
      }),
    });

    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      claimed: 1,
      startupsSucceeded: 0,
      startupsFailed: 1,
    });
    expect(reports).toEqual([
      {
        projectId: "project_a",
        sessionId: "session_1",
        errorMessage: expect.stringContaining("e2b command failed"),
      },
    ]);
    expect(JSON.stringify(reports)).not.toContain("github-secret");
  });

  test("task consumer reports redacted E2B startup failure variants as operator-visible reasons", async () => {
    const bridgeCommandFailures = (() => {
      let commandCount = 0;
      return async (): Promise<E2BCommandResult> => {
        commandCount += 1;
        return commandCount === 4
          ? { ok: false, exitCode: 1, stderr: "bridge failed with github-secret" }
          : { ok: true, exitCode: 0 };
      };
    })();
    const cases = [
      {
        name: "missing GitHub credentials",
        config: { ...e2bConfig(), githubTokenConfigured: false },
        client: createE2BClient().client,
        env: {},
        secretEnvNames: [],
        expected: "GITHUB_TOKEN is required for github bootstrap",
      },
      {
        name: "sandbox creation failure",
        config: e2bConfig(),
        client: createE2BClient({
          createSandbox: async () => {
            throw new Error("sandbox failed with github-secret");
          },
        }).client,
        expected: "sandbox failed with [REDACTED]",
      },
      {
        name: "repository bootstrap failure",
        config: e2bConfig(),
        client: createE2BClient({
          runCommand: async () => ({ ok: false, exitCode: 128, stderr: "clone failed with github-secret" }),
        }).client,
        expected: "e2b command failed (prepare repository, exit 128)",
      },
      {
        name: "bridge startup failure",
        config: e2bConfig(),
        client: createE2BClient({
          runCommand: bridgeCommandFailures,
        }).client,
        expected: "e2b command failed (start bridge, exit 1)",
      },
    ];

    for (const testCase of cases) {
      const reports = await runE2BStartupFailureCase({
        client: testCase.client,
        config: testCase.config,
        env: "env" in testCase ? testCase.env : undefined,
        secretEnvNames: "secretEnvNames" in testCase ? testCase.secretEnvNames : undefined,
      });

      expect(reports).toEqual([
        {
          projectId: "project_a",
          sessionId: "session_1",
          errorMessage: expect.stringContaining(testCase.expected),
        },
      ]);
      expect(JSON.stringify(reports)).not.toContain("github-secret");
    }
  });
});

function bridgeConfig(): Readonly<Record<string, unknown>> {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://api.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "bridge-token",
    },
  };
}

function runtimeSource(): Readonly<Record<string, unknown>> {
  return {
    repositoryUrl: "https://github.com/example/tiny-fixture.git",
    baseRef: "main",
    taskBranchPrefix: "agent-pool/task",
  };
}

function e2bConfig() {
  return {
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
  } as const;
}

async function runE2BStartupFailureCase(options: {
  readonly client: E2BRuntimeClient;
  readonly config: ReturnType<typeof e2bConfig>;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly secretEnvNames?: readonly string[];
}): Promise<readonly unknown[]> {
  const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
  const reports: unknown[] = [];
  const backend: TaskQueueConsumerBackend = {
    claimNextTask: async () => ({
      ok: true,
      status: 200,
      body: {
        ok: true,
        claimed: true,
        task: { id: "task_1", title: "Run E2B", runtimeSource: runtimeSource() },
        session: { id: "session_1", bridge: bridgeConfig() },
        event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
        outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "project.project_a.control" },
      },
    }),
    reportStartupSucceeded: async () => {
      throw new Error("startup success report should not be called");
    },
    reportStartupFailed: async (input) => {
      reports.push(input);
      return {
        ok: true,
        status: 200,
        body: {
          ok: true,
          idempotent: false,
          session: { id: input.sessionId, status: "failed" },
          task: { id: "task_1", status: "blocked" },
          event: null,
          outbox: null,
        },
      };
    },
  };

  queue.publishProjectTaskHint("project_a", { taskId: "task_1" });
  await runTaskQueueConsumerOnce({
    projectId: "project_a",
    queue,
    backend,
    runtimeProvider: "e2b",
    runtimeStarter: createRuntimeStarter({
      providerKind: "e2b",
      e2b: {
        client: options.client,
        config: options.config,
        env: options.env ?? { GITHUB_TOKEN: "github-secret" },
        secretEnvNames: options.secretEnvNames ?? ["GITHUB_TOKEN"],
      },
    }),
  });

  return reports;
}

type E2BClientCall =
  | { readonly kind: "create"; readonly input: E2BSandboxCreateInput }
  | {
      readonly kind: "command";
      readonly sandboxId: string;
      readonly command: readonly string[];
      readonly options: E2BCommandRunOptions;
    };

function createE2BClient(overrides: {
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
    async destroySandbox() {
      return undefined;
    },
    async createSnapshot() {
      return { snapshotId: "snapshot_1" };
    },
    async deleteSnapshot() {
      return undefined;
    },
  };

  return { client, calls };
}
