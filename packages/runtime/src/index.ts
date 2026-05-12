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
};

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  startSession(request: RuntimeSessionRequest): Promise<RuntimeSessionHandle>;
  stopSession(handle: RuntimeSessionHandle): Promise<void>;
}

export type FakeRuntimeScenario = {
  readonly startup?: "success" | "failure";
  readonly startupErrorMessage?: string;
  readonly runtimeSessionId?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type FakeRuntimeProviderOptions = {
  readonly clock?: RuntimeClock;
  readonly sessionIdFactory?: () => string;
  readonly workspaceRoot?: string;
  readonly scenario?: FakeRuntimeScenario;
};

export type FakeRuntimeSessionRecord = {
  readonly request: RuntimeSessionRequest;
  readonly handle: RuntimeSessionHandle;
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
      readonly kind: "e2b" | "docker";
    };

export const RUNTIME_PACKAGE_BOUNDARY = {
  providerInterfaceOnly: false,
  fakeProviderIncluded: true,
  defaultProviderUsesExternalServices: false,
  realE2BImplementationIncluded: false,
  dockerImplementationIncluded: false,
} as const;

export function createRuntimeProvider(options: RuntimeProviderFactoryOptions): RuntimeProvider {
  if (options.kind === "fake") {
    return createFakeRuntimeProvider(options.fake);
  }

  return createUnavailableRuntimeProvider(options.kind);
}

export function createFakeRuntimeProvider(options: FakeRuntimeProviderOptions = {}): FakeRuntimeProvider {
  const clock = options.clock ?? { now: () => new Date() };
  const sessionIdFactory = options.sessionIdFactory ?? sequentialRuntimeSessionIdFactory("fake-runtime");
  let started: FakeRuntimeSessionRecord[] = [];
  let stopped: RuntimeSessionHandle[] = [];
  let active: RuntimeSessionHandle[] = [];

  return {
    kind: "fake",
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

      const handle: RuntimeSessionHandle = {
        provider: "fake",
        sessionId: scenario.runtimeSessionId ?? sessionIdFactory(),
        projectId: request.projectId,
        taskId: request.taskId,
        workspaceRoot: request.workspaceRoot ?? request.bridge?.workspaceRoot ?? options.workspaceRoot,
        startedAt: clock.now().toISOString(),
        metadata: scenario.metadata,
      };

      started = [...started, { request, handle }];
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

function createUnavailableRuntimeProvider(kind: "e2b" | "docker"): RuntimeProvider {
  return {
    kind,
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
