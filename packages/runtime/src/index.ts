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
  readonly bridge?: RuntimeBridgeSessionOptions;
  readonly workspaceRoot?: string;
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
}

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
};

export type E2BSandboxCreateInput = Readonly<Record<string, unknown>>;

export type E2BSandboxHandle = {
  readonly sandboxId: string;
};

export interface E2BRuntimeClient {
  createSandbox(input: E2BSandboxCreateInput): Promise<E2BSandboxHandle>;
  destroySandbox(sandboxId: string): Promise<void>;
}

export type E2BRuntimeProviderOptions = {
  readonly client?: E2BRuntimeClient;
  readonly config?: E2BRuntimeProviderConfig;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly secretEnvNames?: readonly string[];
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
  readonly environment: {
    readonly variables: Readonly<Record<string, string>>;
    readonly secrets: Readonly<Record<string, string>>;
  };
};

export type RuntimeTaskSourceMetadata = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
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
};

export function createFakeRuntimeProvider(options: FakeRuntimeProviderOptions = {}): FakeRuntimeProvider {
  const clock = options.clock ?? { now: () => new Date() };
  const sessionIdFactory = options.sessionIdFactory ?? sequentialRuntimeSessionIdFactory("fake-runtime");
  let started: FakeRuntimeSessionRecord[] = [];
  let stopped: RuntimeSessionHandle[] = [];
  let active: RuntimeSessionHandle[] = [];

  return {
    kind: "fake",
    capabilities: START_STOP_CAPABILITIES,
    get state(): FakeRuntimeProviderState {
      return {
        started: [...started],
        stopped: [...stopped],
        active: [...active],
      };
    },
    async startSession(request): Promise<RuntimeSessionHandle> {
      const scenario = options.scenario ?? {};
      if (scenario.startup === "failure") {
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
      return handle;
    },
    async stopSession(handle): Promise<void> {
      if (handle.provider !== "fake") {
        throw new Error(`fake runtime cannot stop ${handle.provider} session`);
      }

      active = active.filter((candidate) => candidate.sessionId !== handle.sessionId);
      if (!stopped.some((candidate) => candidate.sessionId === handle.sessionId)) {
        stopped = [...stopped, handle];
      }
    },
  };
}

export function createE2BRuntimeProvider(options: E2BRuntimeProviderOptions = {}): RuntimeProvider {
  return {
    kind: "e2b",
    capabilities: START_STOP_CAPABILITIES,
    async startSession(): Promise<RuntimeSessionHandle> {
      assertE2BProviderReady(options);
      throw new Error("e2b runtime provider launch spec is not implemented yet");
    },
    async stopSession(handle): Promise<void> {
      if (handle.provider !== "e2b") {
        throw new Error(`e2b runtime cannot stop ${handle.provider} session`);
      }
      assertE2BProviderReady(options);
      return undefined;
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
  const allowedSecretEnvNames = new Set(config.allowedSecretEnvNames ?? []);
  const requestedSecretEnvNames = options.secretEnvNames ?? config.allowedSecretEnvNames ?? [];
  const secrets: Record<string, string> = {};

  for (const name of requestedSecretEnvNames) {
    if (!allowedSecretEnvNames.has(name)) {
      throw new Error(`e2b launch spec rejected unscoped secret env var: ${name}`);
    }
    const value = options.env?.[name]?.trim();
    if (value) secrets[name] = value;
  }

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
    environment: {
      variables: {
        AGENT_POOL_PROJECT_ID: request.projectId,
        AGENT_POOL_TASK_ID: request.taskId,
        AGENT_POOL_SESSION_ID: request.sessionId ?? request.bridge.sessionId,
        AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: request.bridge.callbackBaseUrl,
        AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: request.bridge.sessionToken.headerName,
      },
      secrets,
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
      variables: spec.environment.variables,
      secrets: Object.fromEntries(Object.keys(spec.environment.secrets).map((name) => [name, "[REDACTED]" as const])),
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
      label: "clone repository",
      command: ["git", "clone", "--no-checkout", runtimeSource.repositoryUrl, workingDirectory],
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

function sanitizeRuntimeTaskSource(input: RuntimeTaskSourceMetadata | null | undefined): RuntimeTaskSourceMetadata | null {
  if (!input) return null;
  const repositoryUrl = input.repositoryUrl.trim();
  const baseRef = input.baseRef.trim();
  const taskBranchPrefix = input.taskBranchPrefix.trim();
  const serialized = JSON.stringify({ repositoryUrl, baseRef, taskBranchPrefix });

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

  return { repositoryUrl, baseRef, taskBranchPrefix };
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
    },
    async startSession(): Promise<RuntimeSessionHandle> {
      throw new Error(`${kind} runtime provider is not implemented in default CI`);
    },
    async stopSession(): Promise<void> {
      return undefined;
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
