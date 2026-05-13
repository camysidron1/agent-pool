import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, normalize, relative } from "node:path";

import {
  createBridgeRunner,
  type BridgeLogStreamKind,
  type BridgeRunnerRunOnceResult,
  type BridgeScheduler,
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
