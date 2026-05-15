import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import {
  buildSandboxBridgeStartupCommand,
  createBridgeRunner,
  type BridgeLogStreamKind,
  type BridgeRunnerRunOnceResult,
  type BridgeScheduler,
  type SandboxBridgeStartupCommand,
} from "@agent-pool/session-bridge";

export type RuntimeProviderKind = "fake" | "e2b" | "docker";

export type RuntimeLifecycleLogLevel = "debug" | "info" | "warn" | "error";

export type RuntimeLifecycleLogEvent = {
  readonly level?: RuntimeLifecycleLogLevel;
  readonly event: string;
  readonly provider: RuntimeProviderKind | string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly sessionId?: string;
  readonly sandboxId?: string;
  readonly snapshotId?: string;
  readonly sourceSnapshotId?: string | null;
  readonly commandLabel?: string;
  readonly command?: readonly string[];
  readonly exitCode?: number | string;
  readonly reason?: string;
  readonly errorMessage?: string;
};

export type RuntimeLifecycleLogger = (event: RuntimeLifecycleLogEvent) => void;

export type RuntimeClock = {
  readonly now: () => Date;
};

export type RuntimeBridgeSessionOptions = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly callbackBaseUrl: string;
  readonly sessionToken: {
    readonly headerName: string;
    readonly token: string;
  };
  readonly workspaceRoot?: string;
};

export type RuntimeSessionRequest = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId?: string;
  readonly task?: Readonly<Record<string, unknown>>;
  readonly session?: Readonly<Record<string, unknown>>;
  readonly sourceSnapshot?: RuntimeSourceSnapshot | null;
  readonly bridge?: RuntimeBridgeSessionOptions;
  readonly workspaceRoot?: string;
  readonly secretEnvironment?: Readonly<Record<string, string>>;
};

export type RuntimeSourceSnapshot = {
  readonly id: string;
  readonly provider: RuntimeProviderKind | string;
  readonly providerSnapshotId: string;
};

export type RuntimeSessionHandle = {
  readonly provider: RuntimeProviderKind;
  readonly sessionId: string;
  readonly projectId?: string;
  readonly taskId?: string;
  readonly workspaceRoot?: string;
  readonly startedAt?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly afterStartup?: () => Promise<void>;
};

export type RuntimeProviderCapabilities = {
  readonly start: boolean;
  readonly stop: boolean;
  readonly suspend: boolean;
  readonly resume: boolean;
  readonly fork: boolean;
  readonly snapshot: boolean;
  readonly deleteSnapshot: boolean;
  readonly startFromSnapshot: boolean;
};

export type FakeRuntimeOutput = {
  readonly stream?: BridgeLogStreamKind;
  readonly text: string;
};

export type FakeRuntimeDocumentFixture = {
  readonly path: string;
  readonly contents: string;
};

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  readonly capabilities: RuntimeProviderCapabilities;
  startSession(request: RuntimeSessionRequest): Promise<RuntimeSessionHandle>;
  stopSession(handle: RuntimeSessionHandle): Promise<void>;
  createSnapshot(handle: RuntimeSessionHandle): Promise<RuntimeSnapshotHandle>;
  deleteSnapshot(snapshot: RuntimeSnapshotHandle): Promise<void>;
}

export type RuntimeSnapshotHandle = {
  readonly provider: RuntimeProviderKind;
  readonly snapshotId: string;
  readonly sourceSessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type E2BRuntimeProviderConfig = {
  readonly apiKeyEnvName: string;
  readonly apiKeyConfigured: boolean;
  readonly templateId?: string | null;
  readonly sandboxImageId?: string | null;
  readonly workingDirectory?: string;
  readonly startupTimeoutMs?: number;
  readonly cleanupTimeoutMs?: number;
  readonly githubTokenEnvName?: string;
  readonly githubTokenConfigured?: boolean;
  readonly allowedSecretEnvNames?: readonly string[];
  readonly agentRunnerMode?: "bridge-smoke" | "codex";
  readonly codexCommand?: string;
  readonly codexApiKeyEnvName?: string;
  readonly codexApiKeyConfigured?: boolean;
  readonly codexModel?: string | null;
  readonly codexCommandProfile?: string;
  readonly egressProxyUrl?: string | null;
  readonly egressProxyAllowOut?: readonly string[];
  readonly egressProxyNoProxy?: string | null;
  readonly packageProxyUrl?: string | null;
  readonly localAllowDirectEgress?: boolean;
  readonly allowedEgressDomains?: readonly string[];
};

export type E2BSandboxCreateInput = {
  readonly launchSpec: E2BLaunchSpec;
  readonly redactedLaunchSpec: RedactedE2BLaunchSpec;
};

export type E2BSandboxHandle = {
  readonly sandboxId: string;
};

export type E2BCommandRunOptions = {
  readonly env?: Readonly<Record<string, string>>;
  readonly timeoutMs?: number;
};

export type E2BCommandResult = {
  readonly ok: boolean;
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
};

export type E2BDestroySandboxOptions = {
  readonly timeoutMs?: number;
};

export type E2BCreateSnapshotOptions = {
  readonly timeoutMs?: number;
};

export type E2BDeleteSnapshotOptions = {
  readonly timeoutMs?: number;
};

export type E2BSnapshotHandle = {
  readonly snapshotId: string;
};

export interface E2BRuntimeClient {
  createSandbox(input: E2BSandboxCreateInput): Promise<E2BSandboxHandle>;
  runCommand(sandboxId: string, command: readonly string[], options: E2BCommandRunOptions): Promise<E2BCommandResult>;
  destroySandbox(sandboxId: string, options?: E2BDestroySandboxOptions): Promise<void>;
  createSnapshot(sandboxId: string, options?: E2BCreateSnapshotOptions): Promise<E2BSnapshotHandle>;
  deleteSnapshot(snapshotId: string, options?: E2BDeleteSnapshotOptions): Promise<void>;
}

export type E2BRuntimeProviderOptions = {
  readonly client?: E2BRuntimeClient;
  readonly config?: E2BRuntimeProviderConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly secretEnvNames?: readonly string[];
  readonly logger?: RuntimeLifecycleLogger;
};

export type E2BLaunchSpec = {
  readonly provider: "e2b";
  readonly sandbox: {
    readonly templateId: string | null;
    readonly sandboxImageId: string | null;
    readonly workingDirectory: string;
    readonly startupTimeoutMs: number;
    readonly cleanupTimeoutMs: number;
  };
  readonly session: {
    readonly projectId: string;
    readonly taskId: string;
    readonly sessionId: string;
  };
  readonly bridge: RuntimeBridgeSessionOptions;
  readonly sourceSnapshot: {
    readonly id: string;
    readonly providerSnapshotId: string;
  } | null;
  readonly environment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secrets: Readonly<Record<string, string>>;
  };
  readonly runner: {
    readonly mode: "bridge-smoke" | "codex";
    readonly codex: {
      readonly command: string;
      readonly apiKeyEnvName: string;
      readonly model: string | null;
      readonly commandProfile: string;
    } | null;
  };
  readonly network: {
    readonly egressMode: "proxy" | "test-direct";
    readonly allowInternetAccess: boolean;
    readonly allowOut: readonly string[];
    readonly allowPublicTraffic: boolean;
    readonly proxyUrl: string | null;
    readonly noProxy: string | null;
  };
};

export type RuntimeTaskSourceMetadata = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
  readonly allowedEgressDomains?: readonly string[];
  readonly commandProfile?: string | null;
};

export type GitHubBootstrapCommand = {
  readonly label: string;
  readonly command: readonly string[];
};

export type GitHubBootstrapPlan = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly branchName: string;
  readonly workingDirectory: string;
  readonly commands: readonly GitHubBootstrapCommand[];
  readonly environment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secretEnvNames: readonly string[];
  };
};

export type SandboxBridgeStartupPlan = SandboxBridgeStartupCommand & {
  readonly redactedEnv: Omit<SandboxBridgeStartupCommand["env"], "AGENT_POOL_BRIDGE_SESSION_TOKEN"> & {
    readonly AGENT_POOL_BRIDGE_SESSION_TOKEN: "[REDACTED]";
  };
};

export type RedactedE2BLaunchSpec = Omit<E2BLaunchSpec, "environment" | "bridge"> & {
  readonly bridge: Omit<RuntimeBridgeSessionOptions, "sessionToken"> & {
    readonly sessionToken: {
      readonly headerName: string;
      readonly token: "[REDACTED]";
    };
  };
  readonly environment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secrets: Readonly<Record<string, "[REDACTED]">>;
  };
};

export type FakeRuntimeScenario = {
  readonly startup?: "success" | "failure";
  readonly startupErrorMessage?: string;
  readonly runtime?: "success" | "failure";
  readonly runtimeErrorMessage?: string;
  readonly runtimeSessionId?: string;
  readonly output?: readonly FakeRuntimeOutput[];
  readonly documents?: readonly FakeRuntimeDocumentFixture[];
  readonly finalResponseText?: string;
  readonly finalResponseMetadata?: Readonly<Record<string, unknown>>;
  readonly completionMetadata?: Readonly<Record<string, unknown>>;
  readonly failureMetadata?: Readonly<Record<string, unknown>>;
  readonly cleanupReason?: string;
  readonly cleanupMetadata?: Readonly<Record<string, unknown>>;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type FakeRuntimeProviderOptions = {
  readonly clock?: RuntimeClock;
  readonly fetch?: typeof fetch;
  readonly scheduler?: BridgeScheduler;
  readonly bridgeRunMode?: "immediate" | "after-startup";
  readonly sessionIdFactory?: () => string;
  readonly workspaceRoot?: string;
  readonly scenario?: FakeRuntimeScenario;
  readonly logger?: RuntimeLifecycleLogger;
};

export type FakeRuntimeBridgeRunRecord = {
  readonly workspaceRoot: string;
  readonly status: "success" | "failure";
  readonly result: BridgeRunnerRunOnceResult;
};

export type FakeRuntimeSessionRecord = {
  readonly request: RuntimeSessionRequest;
  readonly handle: RuntimeSessionHandle;
  readonly bridgeRun?: FakeRuntimeBridgeRunRecord;
};

export type FakeRuntimeProviderState = {
  readonly started: readonly FakeRuntimeSessionRecord[];
  readonly stopped: readonly RuntimeSessionHandle[];
  readonly active: readonly RuntimeSessionHandle[];
  readonly snapshots: readonly RuntimeSnapshotHandle[];
  readonly deletedSnapshots: readonly RuntimeSnapshotHandle[];
};

export type FakeRuntimeProvider = RuntimeProvider & {
  readonly kind: "fake";
  readonly state: FakeRuntimeProviderState;
};

export type RuntimeProviderFactoryOptions =
  | {
      readonly kind: "fake";
      readonly fake?: FakeRuntimeProviderOptions;
    }
  | {
      readonly kind: "e2b";
      readonly e2b?: E2BRuntimeProviderOptions;
    }
  | {
      readonly kind: "docker";
    };

export const RUNTIME_PACKAGE_BOUNDARY = {
  providerInterfaceOnly: false,
  fakeProviderIncluded: true,
  e2bProviderIncluded: true,
  defaultProviderUsesExternalServices: false,
  realE2BImplementationIncluded: true,
  e2bSdkImportedAtModuleLoad: false,
  dockerImplementationIncluded: false,
} as const;

export function createRuntimeProvider(options: RuntimeProviderFactoryOptions): RuntimeProvider {
  if (options.kind === "fake") {
    return createFakeRuntimeProvider(options.fake);
  }
  if (options.kind === "e2b") {
    return createE2BRuntimeProvider(options.e2b);
  }

  return createUnavailableRuntimeProvider(options.kind);
}

const START_STOP_CAPABILITIES: RuntimeProviderCapabilities = {
  start: true,
  stop: true,
  suspend: false,
  resume: false,
  fork: false,
  snapshot: false,
  deleteSnapshot: false,
  startFromSnapshot: false,
};

const E2B_CAPABILITIES: RuntimeProviderCapabilities = {
  start: true,
  stop: true,
  suspend: false,
  resume: false,
  fork: false,
  snapshot: true,
  deleteSnapshot: true,
  startFromSnapshot: true,
};

const FAKE_CAPABILITIES: RuntimeProviderCapabilities = {
  start: true,
  stop: true,
  suspend: false,
  resume: false,
  fork: false,
  snapshot: true,
  deleteSnapshot: true,
  startFromSnapshot: true,
};

export function createFakeRuntimeProvider(options: FakeRuntimeProviderOptions = {}): FakeRuntimeProvider {
  const clock = options.clock ?? { now: () => new Date() };
  const sessionIdFactory = options.sessionIdFactory ?? sequentialRuntimeSessionIdFactory("fake-runtime");
  let started: FakeRuntimeSessionRecord[] = [];
  let stopped: RuntimeSessionHandle[] = [];
  let active: RuntimeSessionHandle[] = [];
  let snapshots: RuntimeSnapshotHandle[] = [];
  let deletedSnapshots: RuntimeSnapshotHandle[] = [];

  return {
    kind: "fake",
    capabilities: FAKE_CAPABILITIES,
    get state(): FakeRuntimeProviderState {
      return {
        started: [...started],
        stopped: [...stopped],
        active: [...active],
        snapshots: [...snapshots],
        deletedSnapshots: [...deletedSnapshots],
      };
    },
    async startSession(request): Promise<RuntimeSessionHandle> {
      const scenario = options.scenario ?? {};
      const logBase = {
        provider: "fake",
        projectId: request.projectId,
        taskId: request.taskId,
        sessionId: request.sessionId ?? request.bridge?.sessionId,
        sourceSnapshotId: request.sourceSnapshot?.id ?? null,
      } as const;
      emitRuntimeLog(options.logger, {
        ...logBase,
        event: "runtime.sandbox.starting",
      });
      if (scenario.startup === "failure") {
        emitRuntimeLog(options.logger, {
          ...logBase,
          level: "error",
          event: "runtime.sandbox.start_failed",
          errorMessage: scenario.startupErrorMessage ?? "fake runtime startup failed",
        });
        throw new Error(scenario.startupErrorMessage ?? "fake runtime startup failed");
      }
      const runtimeSessionId = scenario.runtimeSessionId ?? sessionIdFactory();
      const workspaceRoot = resolveFakeWorkspaceRoot(request, options, runtimeSessionId);
      const bridgeRunInput = request.bridge
        ? {
            request,
            workspaceRoot: workspaceRoot ?? resolveRequiredFakeWorkspaceRoot(runtimeSessionId),
            scenario,
            clock,
            fetch: options.fetch,
            scheduler: options.scheduler,
          }
        : null;
      let bridgeRunPromise: Promise<FakeRuntimeBridgeRunRecord> | null = null;
      const runBridge = (): Promise<FakeRuntimeBridgeRunRecord> => {
        if (!bridgeRunInput) {
          throw new Error("fake bridge session requires bridge options");
        }

        bridgeRunPromise ??= runFakeBridgeSession(bridgeRunInput).then((bridgeRun) => {
          started = started.map((record) =>
            record.handle.sessionId === runtimeSessionId ? { ...record, bridgeRun } : record,
          );
          return bridgeRun;
        });
        return bridgeRunPromise;
      };
      const afterStartup =
        bridgeRunInput && options.bridgeRunMode === "after-startup"
          ? async () => {
              await runBridge();
            }
          : undefined;

      const baseHandle: RuntimeSessionHandle = {
        provider: "fake",
        sessionId: runtimeSessionId,
        projectId: request.projectId,
        taskId: request.taskId,
        workspaceRoot,
        startedAt: clock.now().toISOString(),
        metadata: scenario.metadata,
      };
      const handle: RuntimeSessionHandle = afterStartup ? { ...baseHandle, afterStartup } : baseHandle;
      const bridgeRun = bridgeRunInput && !afterStartup ? await runBridge() : undefined;

      started = [...started, { request, handle, bridgeRun }];
      active = [...active, handle];
      emitRuntimeLog(options.logger, {
        ...logBase,
        event: "runtime.sandbox.started",
        sandboxId: runtimeSessionId,
      });
      return handle;
    },
    async stopSession(handle): Promise<void> {
      if (handle.provider !== "fake") {
        throw new Error(`fake runtime cannot stop ${handle.provider} session`);
      }

      emitRuntimeLog(options.logger, {
        event: "runtime.sandbox.cleanup.started",
        provider: "fake",
        projectId: handle.projectId,
        taskId: handle.taskId,
        sessionId: handle.sessionId,
        sandboxId: handle.sessionId,
      });
      active = active.filter((candidate) => candidate.sessionId !== handle.sessionId);
      if (!stopped.some((candidate) => candidate.sessionId === handle.sessionId)) {
        stopped = [...stopped, handle];
      }
      emitRuntimeLog(options.logger, {
        event: "runtime.sandbox.cleanup.succeeded",
        provider: "fake",
        projectId: handle.projectId,
        taskId: handle.taskId,
        sessionId: handle.sessionId,
        sandboxId: handle.sessionId,
      });
    },
    async createSnapshot(handle): Promise<RuntimeSnapshotHandle> {
      if (handle.provider !== "fake") {
        throw new Error(`fake runtime cannot snapshot ${handle.provider} session`);
      }
      emitRuntimeLog(options.logger, {
        event: "runtime.snapshot.create.started",
        provider: "fake",
        projectId: handle.projectId,
        taskId: handle.taskId,
        sessionId: handle.sessionId,
        sandboxId: handle.sessionId,
      });
      const snapshot = {
        provider: "fake" as const,
        snapshotId: `fake-snapshot-${handle.sessionId}`,
        sourceSessionId: handle.sessionId,
        metadata: {
          sandboxId: handle.sessionId,
        },
      };
      snapshots = [...snapshots.filter((candidate) => candidate.snapshotId !== snapshot.snapshotId), snapshot];
      emitRuntimeLog(options.logger, {
        event: "runtime.snapshot.create.succeeded",
        provider: "fake",
        projectId: handle.projectId,
        taskId: handle.taskId,
        sessionId: handle.sessionId,
        sandboxId: handle.sessionId,
        snapshotId: snapshot.snapshotId,
      });
      return snapshot;
    },
    async deleteSnapshot(snapshot): Promise<void> {
      if (snapshot.provider !== "fake") {
        throw new Error(`fake runtime cannot delete ${snapshot.provider} snapshot`);
      }
      emitRuntimeLog(options.logger, {
        event: "runtime.snapshot.delete.started",
        provider: "fake",
        snapshotId: snapshot.snapshotId,
      });
      deletedSnapshots = [...deletedSnapshots, snapshot];
      snapshots = snapshots.filter((candidate) => candidate.snapshotId !== snapshot.snapshotId);
      emitRuntimeLog(options.logger, {
        event: "runtime.snapshot.delete.succeeded",
        provider: "fake",
        snapshotId: snapshot.snapshotId,
      });
    },
  };
}

export function createE2BRuntimeProvider(options: E2BRuntimeProviderOptions = {}): RuntimeProvider {
  const stoppedSandboxIds = new Set<string>();

  return {
    kind: "e2b",
    capabilities: E2B_CAPABILITIES,
    async startSession(request): Promise<RuntimeSessionHandle> {
      return startE2BSession(request, options);
    },
    async stopSession(handle): Promise<void> {
      if (handle.provider !== "e2b") {
        throw new Error(`e2b runtime cannot stop ${handle.provider} session`);
      }
      return stopE2BSession(handle, options, stoppedSandboxIds);
    },
    async createSnapshot(handle): Promise<RuntimeSnapshotHandle> {
      if (handle.provider !== "e2b") {
        throw new Error(`e2b runtime cannot snapshot ${handle.provider} session`);
      }
      return createE2BSnapshot(handle, options);
    },
    async deleteSnapshot(snapshot): Promise<void> {
      if (snapshot.provider !== "e2b") {
        throw new Error(`e2b runtime cannot delete ${snapshot.provider} snapshot`);
      }
      return deleteE2BSnapshot(snapshot, options);
    },
  };
}

export function buildE2BLaunchSpec(request: RuntimeSessionRequest, options: E2BRuntimeProviderOptions = {}): E2BLaunchSpec {
  const config = options.config;
  if (!request.bridge) {
    throw new Error("e2b launch spec requires bridge session options");
  }
  if (!config?.templateId && !config?.sandboxImageId) {
    throw new Error("e2b launch spec requires E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID");
  }

  const workingDirectory = normalizeSandboxWorkingDirectory(config.workingDirectory ?? "/workspace/agent-pool");
  const env = { ...(options.env ?? {}), ...(request.secretEnvironment ?? {}) };
  const runnerMode = config.agentRunnerMode ?? "bridge-smoke";
  const codexApiKeyEnvName = sanitizeEnvName(config.codexApiKeyEnvName ?? "CODEX_API_KEY");
  const codexCommand = config.codexCommand?.trim() || "codex";
  const codexCommandProfile = config.codexCommandProfile?.trim() || "agent-pool-bun-pr";
  const egressProxyUrl = config.egressProxyUrl?.trim() || null;
  const egressAllowOut = [...(config.egressProxyAllowOut ?? [])];
  const egressNoProxy = config.egressProxyNoProxy?.trim() || null;
  const configuredPackageProxyUrl = config.packageProxyUrl?.trim() || null;
  const localAllowDirectEgress = Boolean(config.localAllowDirectEgress);
  const runtimeSource = readRuntimeTaskSource(request.task);
  const branchName = runtimeSource ? createTaskBranchName(runtimeSource.taskBranchPrefix, request.taskId) : null;

  if (runnerMode === "codex") {
    if (!env[codexApiKeyEnvName]?.trim()) {
      throw new Error(`${codexApiKeyEnvName} is required for codex e2b runner`);
    }
    if (!request.secretEnvironment?.[config.githubTokenEnvName ?? "GITHUB_TOKEN"]?.trim()) {
      throw new Error(`${config.githubTokenEnvName ?? "GITHUB_TOKEN"} is required for codex e2b runner`);
    }
    if (!localAllowDirectEgress && (!egressProxyUrl || egressAllowOut.length === 0)) {
      throw new Error("strict egress proxy configuration is required for codex e2b runner");
    }
    if (!runtimeSource?.allowedEgressDomains?.length || runtimeSource.commandProfile !== codexCommandProfile) {
      throw new Error("codex e2b runner requires runtimeSource allowedEgressDomains and commandProfile");
    }
  }

  const allowedSecretEnvNames = new Set(config.allowedSecretEnvNames ?? []);
  const requestedSecretEnvNames = [
    ...(options.secretEnvNames ?? config.allowedSecretEnvNames ?? []),
    ...(runnerMode === "codex" ? [codexApiKeyEnvName, config.githubTokenEnvName ?? "GITHUB_TOKEN"] : []),
  ];
  const secrets: Record<string, string> = {};

  for (const name of new Set(requestedSecretEnvNames)) {
    if (!allowedSecretEnvNames.has(name)) {
      throw new Error(`e2b launch spec rejected unscoped secret env var: ${name}`);
    }
    const value = env[name]?.trim();
    if (value) secrets[name] = value;
  }

  const sessionProxyUrl = runnerMode === "codex" && egressProxyUrl
    ? createSessionProxyUrl({
        proxyUrl: egressProxyUrl,
        projectId: request.projectId,
        sessionId: request.sessionId ?? request.bridge.sessionId,
        proxyToken: request.bridge.sessionToken.token,
      })
    : null;
  const proxyEnvironment = runnerMode === "codex" && sessionProxyUrl
    ? {
        HTTP_PROXY: sessionProxyUrl,
        HTTPS_PROXY: sessionProxyUrl,
        ALL_PROXY: sessionProxyUrl,
        ...(egressNoProxy ? { NO_PROXY: egressNoProxy } : {}),
      }
    : {};
  const sessionPackageProxyUrl = runnerMode === "codex" && !localAllowDirectEgress && runtimeSource?.allowedEgressDomains?.includes("registry.npmjs.org")
    ? createSessionProxyUrl({
        proxyUrl: configuredPackageProxyUrl ?? createDefaultPackageProxyUrl(egressProxyUrl, "registry.npmjs.org"),
        projectId: request.projectId,
        sessionId: request.sessionId ?? request.bridge.sessionId,
        proxyToken: request.bridge.sessionToken.token,
      })
    : null;
  const packageProxyEnvironment: Record<string, string> = sessionPackageProxyUrl
    ? {
        AGENT_POOL_PACKAGE_PROXY_MODE: "controlled-cache",
        AGENT_POOL_PACKAGE_PROXY_URL: sessionPackageProxyUrl,
        BUN_CONFIG_REGISTRY: sessionPackageProxyUrl,
        NPM_CONFIG_REGISTRY: sessionPackageProxyUrl,
      }
    : {};

  return {
    provider: "e2b",
    sandbox: {
      templateId: config.templateId ?? null,
      sandboxImageId: config.sandboxImageId ?? null,
      workingDirectory,
      startupTimeoutMs: config.startupTimeoutMs ?? 120_000,
      cleanupTimeoutMs: config.cleanupTimeoutMs ?? 30_000,
    },
    session: {
      projectId: request.projectId,
      taskId: request.taskId,
      sessionId: request.sessionId ?? request.bridge.sessionId,
    },
    bridge: request.bridge,
    sourceSnapshot: normalizeE2BSourceSnapshot(request.sourceSnapshot),
    environment: {
      variables: {
        AGENT_POOL_PROJECT_ID: request.projectId,
        AGENT_POOL_TASK_ID: request.taskId,
        AGENT_POOL_SESSION_ID: request.sessionId ?? request.bridge.sessionId,
        AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: request.bridge.callbackBaseUrl,
        AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: request.bridge.sessionToken.headerName,
        AGENT_POOL_BRIDGE_RUNNER: runnerMode,
        AGENT_POOL_CODEX_COMMAND: codexCommand,
        AGENT_POOL_CODEX_API_KEY_ENV_NAME: codexApiKeyEnvName,
        AGENT_POOL_CODEX_COMMAND_PROFILE: codexCommandProfile,
        ...(readStringField(request.task, "title") ? { AGENT_POOL_TASK_TITLE: readStringField(request.task, "title") ?? "" } : {}),
        ...(readStringField(request.task, "description")
          ? { AGENT_POOL_TASK_DESCRIPTION: readStringField(request.task, "description") ?? "" }
          : {}),
        ...(runtimeSource
          ? {
              AGENT_POOL_REPOSITORY_URL: runtimeSource.repositoryUrl,
              AGENT_POOL_BASE_REF: runtimeSource.baseRef,
              AGENT_POOL_TASK_BRANCH: branchName ?? "",
            }
          : {}),
        ...(config.codexModel?.trim() ? { AGENT_POOL_CODEX_MODEL: config.codexModel.trim() } : {}),
        ...(runtimeSource?.allowedEgressDomains?.length
          ? { AGENT_POOL_ALLOWED_EGRESS_DOMAINS: runtimeSource.allowedEgressDomains.join(",") }
          : {}),
        ...proxyEnvironment,
        ...packageProxyEnvironment,
      },
      secrets,
    },
    runner: {
      mode: runnerMode,
      codex:
        runnerMode === "codex"
          ? {
              command: codexCommand,
              apiKeyEnvName: codexApiKeyEnvName,
              model: config.codexModel?.trim() || null,
              commandProfile: codexCommandProfile,
            }
          : null,
    },
    network: {
      egressMode: runnerMode === "codex" && !localAllowDirectEgress ? "proxy" : "test-direct",
      allowInternetAccess: runnerMode !== "codex" || localAllowDirectEgress,
      allowOut: runnerMode === "codex" && !localAllowDirectEgress ? egressAllowOut : [],
      allowPublicTraffic: false,
      proxyUrl: sessionProxyUrl,
      noProxy: egressNoProxy,
    },
  };
}

export function redactE2BLaunchSpec(spec: E2BLaunchSpec): RedactedE2BLaunchSpec {
  return {
    ...spec,
    bridge: {
      ...spec.bridge,
      sessionToken: {
        headerName: spec.bridge.sessionToken.headerName,
        token: "[REDACTED]",
      },
    },
    environment: {
      variables: redactE2BVariables(spec.environment.variables),
      secrets: Object.fromEntries(Object.keys(spec.environment.secrets).map((name) => [name, "[REDACTED]" as const])),
    },
    network: {
      ...spec.network,
      proxyUrl: spec.network.proxyUrl ? "[REDACTED]" : null,
    },
  };
}

export function buildGitHubBootstrapPlan(input: {
  readonly runtimeSource?: RuntimeTaskSourceMetadata | null;
  readonly taskId: string;
  readonly workingDirectory: string;
  readonly githubTokenEnvName?: string;
  readonly githubTokenConfigured?: boolean;
}): GitHubBootstrapPlan {
  const runtimeSource = sanitizeRuntimeTaskSource(input.runtimeSource);
  if (!runtimeSource) {
    throw new Error("github bootstrap requires runtime source metadata");
  }
  const githubTokenEnvName = sanitizeEnvName(input.githubTokenEnvName ?? "GITHUB_TOKEN");
  if (!input.githubTokenConfigured) {
    throw new Error(`${githubTokenEnvName} is required for github bootstrap`);
  }
  const workingDirectory = normalizeSandboxWorkingDirectory(input.workingDirectory);
  const branchName = createTaskBranchName(runtimeSource.taskBranchPrefix, input.taskId);
  const commands: GitHubBootstrapCommand[] = [
    {
      label: "prepare repository",
      command: [
        "sh",
        "-lc",
        [
          `if [ -e ${quoteShellArg(workingDirectory)} ] && [ ! -d ${quoteShellArg(`${workingDirectory}/.git`)} ]; then`,
          `  echo ${quoteShellArg("working directory exists but is not a git repository")}; exit 1;`,
          "fi;",
          `if [ ! -d ${quoteShellArg(`${workingDirectory}/.git`)} ]; then`,
          `  git clone --no-checkout ${quoteShellArg(runtimeSource.repositoryUrl)} ${quoteShellArg(workingDirectory)};`,
          "fi",
        ].join(" "),
      ],
    },
    {
      label: "fetch base ref",
      command: ["git", "-C", workingDirectory, "fetch", "--depth", "1", "origin", runtimeSource.baseRef],
    },
    {
      label: "create task branch",
      command: ["git", "-C", workingDirectory, "checkout", "-B", branchName, "FETCH_HEAD"],
    },
  ];

  return {
    repositoryUrl: runtimeSource.repositoryUrl,
    baseRef: runtimeSource.baseRef,
    branchName,
    workingDirectory,
    commands,
    environment: {
      variables: {
        GIT_TERMINAL_PROMPT: "0",
        GIT_ASKPASS: "/agent-pool/bin/github-token-askpass",
        AGENT_POOL_GITHUB_TOKEN_ENV: githubTokenEnvName,
      },
      secretEnvNames: [githubTokenEnvName],
    },
  };
}

export function buildSandboxBridgeStartupPlan(spec: E2BLaunchSpec): SandboxBridgeStartupPlan {
  const startup = buildSandboxBridgeStartupCommand({
    session: spec.bridge,
    workspaceRoot: spec.sandbox.workingDirectory,
  });

  return {
    ...startup,
    redactedEnv: {
      ...startup.env,
      AGENT_POOL_BRIDGE_SESSION_TOKEN: "[REDACTED]",
    },
  };
}

function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("shell argument must not contain NUL bytes");
  }
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function createSessionProxyUrl(input: {
  readonly proxyUrl: string;
  readonly projectId: string;
  readonly sessionId: string;
  readonly proxyToken: string;
}): string {
  const url = new URL(input.proxyUrl);
  url.username = Buffer.from(`${input.projectId}:${input.sessionId}`, "utf8").toString("base64url");
  url.password = input.proxyToken;
  return url.toString();
}

function createDefaultPackageProxyUrl(proxyUrl: string | null, registryHost: string): string {
  if (!proxyUrl) {
    throw new Error("package proxy requires strict egress proxy configuration");
  }
  const url = new URL(proxyUrl);
  url.pathname = `/package/npm/${registryHost}/`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function redactE2BVariables(variables: Readonly<Record<string, string>>): Readonly<Record<string, string>> {
  return Object.fromEntries(
    Object.entries(variables).map(([key, value]) => [
      key,
      key === "HTTP_PROXY" ||
      key === "HTTPS_PROXY" ||
      key === "ALL_PROXY" ||
      key === "AGENT_POOL_PACKAGE_PROXY_URL" ||
      key === "BUN_CONFIG_REGISTRY" ||
      key === "NPM_CONFIG_REGISTRY"
        ? "[REDACTED]"
        : value,
    ]),
  );
}

async function startE2BSession(
  request: RuntimeSessionRequest,
  options: E2BRuntimeProviderOptions,
): Promise<RuntimeSessionHandle> {
  assertE2BProviderReady(options);

  const config = options.config;
  const client = options.client;
  if (!config || !client) {
    throw new Error("e2b runtime provider requires runtime config and an injected E2B client");
  }

  let sandboxId: string | null = null;
  const sessionEnv = { ...(options.env ?? {}), ...(request.secretEnvironment ?? {}) };
  let secretValues: readonly string[] = collectOptionSecretValues(options, request);

  try {
    const launchSpec = buildE2BLaunchSpec(request, options);
    const redactedLaunchSpec = redactE2BLaunchSpec(launchSpec);
    const logBase = {
      provider: "e2b",
      projectId: request.projectId,
      taskId: request.taskId,
      sessionId: launchSpec.session.sessionId,
      sourceSnapshotId: launchSpec.sourceSnapshot?.id ?? null,
    } as const;
    emitRuntimeLog(options.logger, {
      ...logBase,
      event: "runtime.sandbox.starting",
    });
    const bridgeStartup = buildSandboxBridgeStartupPlan(launchSpec);
    const bootstrapPlan = buildGitHubBootstrapPlan({
      runtimeSource: readRuntimeTaskSource(request.task),
      taskId: request.taskId,
      workingDirectory: launchSpec.sandbox.workingDirectory,
      githubTokenEnvName: config.githubTokenEnvName,
      githubTokenConfigured: Boolean(sessionEnv[config.githubTokenEnvName ?? "GITHUB_TOKEN"]?.trim()),
    });
    const bootstrapSecretEnv = pickSecretEnvironment(sessionEnv, bootstrapPlan.environment.secretEnvNames);
    const bootstrapEnv = {
      ...launchSpec.environment.variables,
      ...bootstrapPlan.environment.variables,
      ...bootstrapSecretEnv,
    };
    secretValues = collectE2BSecretValues(launchSpec, bridgeStartup.env, options, request, bootstrapSecretEnv);

    const sandbox = await client.createSandbox({ launchSpec, redactedLaunchSpec });
    sandboxId = normalizeE2BSandboxId(sandbox.sandboxId);
    emitRuntimeLog(options.logger, {
      ...logBase,
      event: "runtime.sandbox.created",
      sandboxId,
    });

    for (const command of bootstrapPlan.commands) {
      await runE2BCommand(client, sandboxId, command.label, command.command, {
        env: bootstrapEnv,
        timeoutMs: launchSpec.sandbox.startupTimeoutMs,
      }, { logger: options.logger, base: logBase, secretValues });
    }

    await runE2BCommand(client, sandboxId, "start bridge", bridgeStartup.command, {
      env: {
        ...launchSpec.environment.variables,
        ...launchSpec.environment.secrets,
        ...bridgeStartup.env,
      },
      timeoutMs: launchSpec.sandbox.startupTimeoutMs,
    }, { logger: options.logger, base: logBase, secretValues });
    emitRuntimeLog(options.logger, {
      ...logBase,
      event: "runtime.sandbox.started",
      sandboxId,
    });

    return {
      provider: "e2b",
      sessionId: sandboxId,
      projectId: request.projectId,
      taskId: request.taskId,
      workspaceRoot: launchSpec.sandbox.workingDirectory,
      startedAt: new Date().toISOString(),
      metadata: {
        agentPoolSessionId: launchSpec.session.sessionId,
        sandboxId,
        branchName: bootstrapPlan.branchName,
        bootstrapCommands: bootstrapPlan.commands.length,
        bridgeCommandAccepted: true,
        runnerMode: launchSpec.runner.mode,
        network: launchSpec.network,
        launchSpec: redactedLaunchSpec,
        bridgeStartupEnv: bridgeStartup.redactedEnv,
      },
    };
  } catch (error) {
    if (sandboxId) {
      const cleanupSandboxId = sandboxId;
      emitRuntimeLog(options.logger, {
        event: "runtime.sandbox.cleanup.started",
        provider: "e2b",
        projectId: request.projectId,
        taskId: request.taskId,
        sessionId: request.sessionId ?? request.bridge?.sessionId,
        sandboxId: cleanupSandboxId,
        reason: "startup_failed",
      });
      await client
        .destroySandbox(cleanupSandboxId, { timeoutMs: config.cleanupTimeoutMs ?? 30_000 })
        .then(() => {
          emitRuntimeLog(options.logger, {
            event: "runtime.sandbox.cleanup.succeeded",
            provider: "e2b",
            projectId: request.projectId,
            taskId: request.taskId,
            sessionId: request.sessionId ?? request.bridge?.sessionId,
            sandboxId: cleanupSandboxId,
            reason: "startup_failed",
          });
        })
        .catch((cleanupError) => {
          emitRuntimeLog(options.logger, {
            level: "error",
            event: "runtime.sandbox.cleanup.failed",
            provider: "e2b",
            projectId: request.projectId,
            taskId: request.taskId,
            sessionId: request.sessionId ?? request.bridge?.sessionId,
            sandboxId: cleanupSandboxId,
            reason: "startup_failed",
            errorMessage: redactSecretValues(errorMessage(cleanupError), secretValues),
          });
        });
    }
    emitRuntimeLog(options.logger, {
      level: "error",
      event: "runtime.sandbox.start_failed",
      provider: "e2b",
      projectId: request.projectId,
      taskId: request.taskId,
      sessionId: request.sessionId ?? request.bridge?.sessionId,
      sandboxId: sandboxId ?? undefined,
      errorMessage: redactSecretValues(errorMessage(error), secretValues),
    });
    throw new Error(redactSecretValues(errorMessage(error), secretValues));
  }
}

async function stopE2BSession(
  handle: RuntimeSessionHandle,
  options: E2BRuntimeProviderOptions,
  stoppedSandboxIds: Set<string>,
): Promise<void> {
  assertE2BProviderReady(options);

  const config = options.config;
  const client = options.client;
  if (!config || !client) {
    throw new Error("e2b runtime provider requires runtime config and an injected E2B client");
  }

  const sandboxId = readE2BSandboxId(handle);
  const sessionId = readRuntimeLogSessionId(handle);
  if (stoppedSandboxIds.has(sandboxId)) {
    emitRuntimeLog(options.logger, {
      event: "runtime.sandbox.cleanup.skipped",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
      reason: "already_stopped",
    });
    return;
  }

  try {
    emitRuntimeLog(options.logger, {
      event: "runtime.sandbox.cleanup.started",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
    });
    await client.destroySandbox(sandboxId, { timeoutMs: config.cleanupTimeoutMs ?? 30_000 });
    stoppedSandboxIds.add(sandboxId);
    emitRuntimeLog(options.logger, {
      event: "runtime.sandbox.cleanup.succeeded",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
    });
  } catch (error) {
    emitRuntimeLog(options.logger, {
      level: "error",
      event: "runtime.sandbox.cleanup.failed",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
      errorMessage: redactSecretValues(errorMessage(error), collectOptionSecretValues(options)),
    });
    throw new Error(redactSecretValues(errorMessage(error), collectOptionSecretValues(options)));
  }
}

async function createE2BSnapshot(
  handle: RuntimeSessionHandle,
  options: E2BRuntimeProviderOptions,
): Promise<RuntimeSnapshotHandle> {
  assertE2BProviderReady(options);

  const config = options.config;
  const client = options.client;
  if (!config || !client) {
    throw new Error("e2b runtime provider requires runtime config and an injected E2B client");
  }

  const sandboxId = readE2BSandboxId(handle);
  const sessionId = readRuntimeLogSessionId(handle);
  try {
    emitRuntimeLog(options.logger, {
      event: "runtime.snapshot.create.started",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
    });
    const snapshot = await client.createSnapshot(sandboxId, { timeoutMs: config.cleanupTimeoutMs ?? 30_000 });
    emitRuntimeLog(options.logger, {
      event: "runtime.snapshot.create.succeeded",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
      snapshotId: snapshot.snapshotId,
    });
    return {
      provider: "e2b",
      snapshotId: snapshot.snapshotId,
      sourceSessionId: handle.sessionId,
      metadata: {
        sandboxId,
      },
    };
  } catch (error) {
    emitRuntimeLog(options.logger, {
      level: "error",
      event: "runtime.snapshot.create.failed",
      provider: "e2b",
      projectId: handle.projectId,
      taskId: handle.taskId,
      sessionId,
      sandboxId,
      errorMessage: redactSecretValues(errorMessage(error), collectOptionSecretValues(options)),
    });
    throw new Error(redactSecretValues(errorMessage(error), collectOptionSecretValues(options)));
  }
}

async function deleteE2BSnapshot(snapshot: RuntimeSnapshotHandle, options: E2BRuntimeProviderOptions): Promise<void> {
  assertE2BProviderReady(options);

  const config = options.config;
  const client = options.client;
  if (!config || !client) {
    throw new Error("e2b runtime provider requires runtime config and an injected E2B client");
  }

  try {
    emitRuntimeLog(options.logger, {
      event: "runtime.snapshot.delete.started",
      provider: "e2b",
      snapshotId: snapshot.snapshotId,
    });
    await client.deleteSnapshot(snapshot.snapshotId, { timeoutMs: config.cleanupTimeoutMs ?? 30_000 });
    emitRuntimeLog(options.logger, {
      event: "runtime.snapshot.delete.succeeded",
      provider: "e2b",
      snapshotId: snapshot.snapshotId,
    });
  } catch (error) {
    emitRuntimeLog(options.logger, {
      level: "error",
      event: "runtime.snapshot.delete.failed",
      provider: "e2b",
      snapshotId: snapshot.snapshotId,
      errorMessage: redactSecretValues(errorMessage(error), collectOptionSecretValues(options)),
    });
    throw new Error(redactSecretValues(errorMessage(error), collectOptionSecretValues(options)));
  }
}

async function runE2BCommand(
  client: E2BRuntimeClient,
  sandboxId: string,
  label: string,
  command: readonly string[],
  options: E2BCommandRunOptions,
  log?: {
    readonly logger?: RuntimeLifecycleLogger;
    readonly base: Omit<RuntimeLifecycleLogEvent, "event" | "command" | "commandLabel" | "exitCode" | "level" | "errorMessage">;
    readonly secretValues: readonly string[];
  },
): Promise<void> {
  const base = log?.base;
  if (base) {
    emitRuntimeLog(log?.logger, {
      ...base,
      event: "runtime.command.started",
      sandboxId,
      commandLabel: label,
      command: redactCommand(command, log.secretValues),
    });
  }
  let result: E2BCommandResult;
  try {
    result = await client.runCommand(sandboxId, command, options);
  } catch (error) {
    if (base) {
      emitRuntimeLog(log?.logger, {
        ...base,
        level: "error",
        event: "runtime.command.failed",
        sandboxId,
        commandLabel: label,
        command: redactCommand(command, log.secretValues),
        errorMessage: redactSecretValues(errorMessage(error), log.secretValues),
      });
    }
    throw error;
  }
  if (result.ok) {
    if (base) {
      emitRuntimeLog(log?.logger, {
        ...base,
        event: "runtime.command.succeeded",
        sandboxId,
        commandLabel: label,
        exitCode: typeof result.exitCode === "number" ? result.exitCode : 0,
      });
    }
    return;
  }

  const exitCode = typeof result.exitCode === "number" ? result.exitCode : "unknown";
  const output = firstNonEmptyString(result.stderr, result.stdout, "no command output");
  if (base) {
    emitRuntimeLog(log?.logger, {
      ...base,
      level: "error",
      event: "runtime.command.failed",
      sandboxId,
      commandLabel: label,
      command: redactCommand(command, log.secretValues),
      exitCode,
      errorMessage: redactSecretValues(output, log.secretValues),
    });
  }
  throw new Error(`e2b command failed (${label}, exit ${exitCode}): ${output}`);
}

function readRuntimeTaskSource(task: Readonly<Record<string, unknown>> | undefined): RuntimeTaskSourceMetadata | null {
  if (!task) return null;
  const value = task.runtimeSource;
  if (!value || typeof value !== "object") return null;
  const source = value as Readonly<Record<string, unknown>>;
  const repositoryUrl = readStringField(source, "repositoryUrl");
  const baseRef = readStringField(source, "baseRef");
  const taskBranchPrefix = readStringField(source, "taskBranchPrefix");
  const commandProfile = readStringField(source, "commandProfile");
  const allowedEgressDomains = readStringArrayField(source, "allowedEgressDomains");

  if (!repositoryUrl || !baseRef || !taskBranchPrefix) {
    throw new Error("github bootstrap runtime source metadata is incomplete");
  }

  return {
    repositoryUrl,
    baseRef,
    taskBranchPrefix,
    ...(allowedEgressDomains.length > 0 ? { allowedEgressDomains } : {}),
    ...(commandProfile ? { commandProfile } : {}),
  };
}

function readStringField(source: Readonly<Record<string, unknown>> | undefined, name: string): string | null {
  if (!source) return null;
  const value = source[name];
  return typeof value === "string" ? value : null;
}

function readStringArrayField(source: Readonly<Record<string, unknown>>, name: string): readonly string[] {
  const value = source[name];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim().length > 0).map((item) => item.trim());
}

function normalizeE2BSandboxId(sandboxId: string): string {
  const trimmed = sandboxId.trim();
  if (!trimmed) {
    throw new Error("e2b runtime provider returned an empty sandbox id");
  }
  return trimmed;
}

function readE2BSandboxId(handle: RuntimeSessionHandle): string {
  const metadataSandboxId = handle.metadata?.sandboxId;
  const sandboxId = typeof metadataSandboxId === "string" && metadataSandboxId.trim() ? metadataSandboxId : handle.sessionId;
  const trimmed = sandboxId.trim();
  if (!trimmed) {
    throw new Error("e2b cleanup requires sandbox id");
  }
  return trimmed;
}

function readRuntimeLogSessionId(handle: RuntimeSessionHandle): string {
  const direct = handle.metadata?.agentPoolSessionId;
  if (typeof direct === "string" && direct.trim()) {
    return direct.trim();
  }

  const launchSpec = handle.metadata?.launchSpec;
  if (launchSpec && typeof launchSpec === "object" && "session" in launchSpec) {
    const session = (launchSpec as Readonly<Record<string, unknown>>).session;
    if (session && typeof session === "object" && "sessionId" in session) {
      const sessionId = (session as Readonly<Record<string, unknown>>).sessionId;
      if (typeof sessionId === "string" && sessionId.trim()) {
        return sessionId.trim();
      }
    }
  }

  return handle.sessionId;
}

function normalizeE2BSourceSnapshot(input: RuntimeSourceSnapshot | null | undefined): E2BLaunchSpec["sourceSnapshot"] {
  if (!input) return null;
  if (input.provider !== "e2b") {
    throw new Error(`e2b launch spec cannot use ${input.provider} source snapshot`);
  }
  const id = input.id.trim();
  const providerSnapshotId = input.providerSnapshotId.trim();
  if (!id || !providerSnapshotId) {
    throw new Error("e2b source snapshot requires snapshot ids");
  }
  return { id, providerSnapshotId };
}

function pickSecretEnvironment(
  env: Readonly<Record<string, string | undefined>>,
  names: readonly string[],
): Readonly<Record<string, string>> {
  const picked: Record<string, string> = {};
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) picked[name] = value;
  }
  return picked;
}

function collectOptionSecretValues(
  options: E2BRuntimeProviderOptions,
  request?: RuntimeSessionRequest,
): readonly string[] {
  const values: string[] = [];
  for (const name of options.secretEnvNames ?? options.config?.allowedSecretEnvNames ?? []) {
    const value = options.env?.[name]?.trim();
    if (value) values.push(value);
  }
  for (const value of Object.values(request?.secretEnvironment ?? {})) {
    const trimmed = value.trim();
    if (trimmed) values.push(trimmed);
  }
  return values;
}

function collectE2BSecretValues(
  spec: E2BLaunchSpec,
  bridgeEnv: SandboxBridgeStartupCommand["env"],
  options: E2BRuntimeProviderOptions,
  request: RuntimeSessionRequest,
  bootstrapSecretEnv: Readonly<Record<string, string>>,
): readonly string[] {
  return [
    ...collectOptionSecretValues(options, request),
    ...Object.values(bootstrapSecretEnv),
    ...Object.values(spec.environment.secrets),
    spec.bridge.sessionToken.token,
    bridgeEnv.AGENT_POOL_BRIDGE_SESSION_TOKEN,
  ];
}

function redactSecretValues(message: string, secretValues: readonly string[]): string {
  let redacted = message;
  for (const secret of new Set(secretValues.filter(Boolean))) {
    redacted = redacted.split(secret).join("[REDACTED]");
  }
  return redacted;
}

function redactCommand(command: readonly string[], secretValues: readonly string[]): readonly string[] {
  return command.map((part) => redactSecretValues(part, secretValues));
}

function emitRuntimeLog(logger: RuntimeLifecycleLogger | undefined, event: RuntimeLifecycleLogEvent): void {
  if (!logger) return;
  try {
    logger(event);
  } catch {
    // Runtime progress should not fail because an observer failed to write a log line.
  }
}

function firstNonEmptyString(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim() ?? "";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sanitizeRuntimeTaskSource(input: RuntimeTaskSourceMetadata | null | undefined): RuntimeTaskSourceMetadata | null {
  if (!input) return null;
  const repositoryUrl = input.repositoryUrl.trim();
  const baseRef = input.baseRef.trim();
  const taskBranchPrefix = input.taskBranchPrefix.trim();
  const allowedEgressDomains = [...(input.allowedEgressDomains ?? [])].map((domain) => domain.trim().toLowerCase()).filter(Boolean);
  const commandProfile = input.commandProfile?.trim() || null;
  const serialized = JSON.stringify({ repositoryUrl, baseRef, taskBranchPrefix, allowedEgressDomains, commandProfile });

  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repositoryUrl)) {
    throw new Error("github bootstrap repositoryUrl must be an https GitHub repository URL");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.includes("..")) {
    throw new Error("github bootstrap baseRef is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(taskBranchPrefix) || taskBranchPrefix.includes("..")) {
    throw new Error("github bootstrap taskBranchPrefix is invalid");
  }
  if (/token|secret|password|github_pat_|ghp_/i.test(serialized)) {
    throw new Error("github bootstrap runtime source must not contain secret values");
  }
  for (const domain of allowedEgressDomains) {
    if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(domain) || domain.includes("*") || domain.includes("/") || domain.includes(":")) {
      throw new Error("github bootstrap allowedEgressDomains contains an invalid domain");
    }
  }
  if (commandProfile !== null && commandProfile !== "agent-pool-bun-pr") {
    throw new Error("github bootstrap commandProfile is unsupported");
  }

  return {
    repositoryUrl,
    baseRef,
    taskBranchPrefix,
    ...(allowedEgressDomains.length > 0 ? { allowedEgressDomains } : {}),
    ...(commandProfile ? { commandProfile } : {}),
  };
}

function createTaskBranchName(prefix: string, taskId: string): string {
  const sanitizedPrefix = prefix.replace(/(^\/+|\/+$)/g, "");
  const sanitizedTaskId = taskId.trim().replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!sanitizedTaskId) {
    throw new Error("github bootstrap taskId is invalid");
  }
  return `${sanitizedPrefix}/${sanitizedTaskId}`;
}

function sanitizeEnvName(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) return trimmed;
  throw new Error("github bootstrap token env name is invalid");
}

function normalizeSandboxWorkingDirectory(path: string): string {
  const trimmed = path.trim();
  if (!trimmed.startsWith("/")) {
    throw new Error("e2b launch spec working directory must be an absolute sandbox path");
  }
  if (
    trimmed.startsWith("/Users/") ||
    trimmed.startsWith("/private/") ||
    trimmed.includes("~") ||
    trimmed.includes("..") ||
    trimmed.includes(".agent-pool/data/agent-pool.db")
  ) {
    throw new Error("e2b launch spec working directory must not reference host paths or the TUI database");
  }

  return trimmed.replace(/\/+$/, "") || "/";
}

function assertE2BProviderReady(options: E2BRuntimeProviderOptions): void {
  const config = options.config;
  if (config && !config.apiKeyConfigured) {
    throw new Error(`${config.apiKeyEnvName} is required to use the e2b runtime provider`);
  }
  if (!options.client) {
    throw new Error("e2b runtime provider requires an injected E2B client");
  }
}

function createUnavailableRuntimeProvider(kind: "docker"): RuntimeProvider {
  return {
    kind,
    capabilities: {
      start: false,
      stop: false,
      suspend: false,
      resume: false,
      fork: false,
      snapshot: false,
      deleteSnapshot: false,
      startFromSnapshot: false,
    },
    async startSession(): Promise<RuntimeSessionHandle> {
      throw new Error(`${kind} runtime provider is not implemented in default CI`);
    },
    async stopSession(): Promise<void> {
      return undefined;
    },
    async createSnapshot(): Promise<RuntimeSnapshotHandle> {
      throw new Error(`${kind} runtime provider cannot create snapshots`);
    },
    async deleteSnapshot(): Promise<void> {
      throw new Error(`${kind} runtime provider cannot delete snapshots`);
    },
  };
}

function sequentialRuntimeSessionIdFactory(prefix: string): () => string {
  let sequence = 0;

  return () => {
    sequence += 1;
    return `${prefix}-${sequence}`;
  };
}

async function runFakeBridgeSession(options: {
  readonly request: RuntimeSessionRequest;
  readonly workspaceRoot: string;
  readonly scenario: FakeRuntimeScenario;
  readonly clock: RuntimeClock;
  readonly fetch?: typeof fetch;
  readonly scheduler?: BridgeScheduler;
}): Promise<FakeRuntimeBridgeRunRecord> {
  if (!options.request.bridge) {
    throw new Error("fake bridge session requires bridge options");
  }

  await prepareFakeWorkspace(options.workspaceRoot, options.request.taskId, options.scenario);

  const status = options.scenario.runtime ?? "success";
  const runner = createBridgeRunner({
    session: options.request.bridge,
    fetch: options.fetch ?? createOfflineBridgeFetch(),
    workspaceRoot: options.workspaceRoot,
    clock: options.clock,
    scheduler: options.scheduler,
  });
  const result = await runner.runOnce({
    output: readFakeRuntimeOutput(options.scenario),
    finalResponseText:
      status === "success"
        ? options.scenario.finalResponseText ?? `Fake runtime completed ${options.request.taskId}.`
        : undefined,
    finalResponseMetadata: status === "success" ? options.scenario.finalResponseMetadata : undefined,
    completion:
      status === "success"
        ? {
            metadata: options.scenario.completionMetadata ?? options.scenario.metadata,
          }
        : undefined,
    failure:
      status === "failure"
        ? {
            errorMessage: options.scenario.runtimeErrorMessage ?? "fake runtime failed",
            metadata: options.scenario.failureMetadata ?? options.scenario.metadata,
          }
        : undefined,
    cleanup: {
      reason:
        options.scenario.cleanupReason ??
        (status === "failure" ? "fake runtime failed" : "fake runtime completed"),
      metadata: options.scenario.cleanupMetadata,
    },
  });

  return {
    workspaceRoot: options.workspaceRoot,
    status,
    result,
  };
}

function readFakeRuntimeOutput(scenario: FakeRuntimeScenario): readonly { readonly stream: BridgeLogStreamKind; readonly text: string }[] {
  return (scenario.output ?? [{ stream: "system", text: "fake runtime started\n" }]).map((chunk) => ({
    stream: chunk.stream ?? "system",
    text: chunk.text,
  }));
}

async function prepareFakeWorkspace(
  workspaceRoot: string,
  taskId: string,
  scenario: FakeRuntimeScenario,
): Promise<void> {
  const documents = scenario.documents ?? defaultFakeDocuments(taskId);

  await mkdir(workspaceRoot, { recursive: true });
  for (const document of documents) {
    const path = resolveWorkspaceRelativePath(workspaceRoot, document.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, document.contents, "utf8");
  }
}

function defaultFakeDocuments(taskId: string): readonly FakeRuntimeDocumentFixture[] {
  return [
    {
      path: "agent-docs/fake-runtime-result.md",
      contents: `# Fake runtime result\n\nTask: ${taskId}\n`,
    },
    {
      path: "shared-docs/fake-runtime-summary.json",
      contents: `${JSON.stringify({ provider: "fake", taskId }, null, 2)}\n`,
    },
  ];
}

function resolveWorkspaceRelativePath(workspaceRoot: string, path: string): string {
  if (isAbsolute(path)) {
    throw new Error(`fake runtime document path must be relative: ${path}`);
  }

  const normalized = normalize(path);
  if (normalized === ".." || normalized.startsWith("../") || normalized.includes("/../")) {
    throw new Error(`fake runtime document path escapes workspace: ${path}`);
  }
  if (!normalized.startsWith("agent-docs/") && !normalized.startsWith("shared-docs/")) {
    throw new Error(`fake runtime document path must be under agent-docs or shared-docs: ${path}`);
  }

  const absolute = join(workspaceRoot, normalized);
  const back = relative(workspaceRoot, absolute);
  if (back === ".." || back.startsWith("../") || isAbsolute(back)) {
    throw new Error(`fake runtime document path escapes workspace: ${path}`);
  }

  return absolute;
}

function resolveFakeWorkspaceRoot(
  request: RuntimeSessionRequest,
  options: FakeRuntimeProviderOptions,
  runtimeSessionId: string,
): string | undefined {
  return request.workspaceRoot ?? request.bridge?.workspaceRoot ?? options.workspaceRoot ?? (request.bridge ? resolveRequiredFakeWorkspaceRoot(runtimeSessionId) : undefined);
}

function resolveRequiredFakeWorkspaceRoot(runtimeSessionId: string): string {
  return join(tmpdir(), "agent-pool-fake-runtime", runtimeSessionId.replace(/[^a-zA-Z0-9._-]/g, "_"));
}

function createOfflineBridgeFetch(): typeof fetch {
  const fetchImpl = async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]): Promise<Response> => {
    const request = new Request(input, init);
    if (request.method !== "POST") {
      return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
    }

    const url = new URL(request.url);
    if (url.pathname === "/steering/poll") {
      return Response.json({ ok: true, messages: [] });
    }

    if (url.pathname.startsWith("/callbacks/")) {
      return Response.json({ ok: true, accepted: true });
    }

    return Response.json({ ok: false, error: "not_found" }, { status: 404 });
  };

  return fetchImpl as typeof fetch;
}
