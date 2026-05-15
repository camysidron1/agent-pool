import type { AppConfig } from "@agent-pool/config";
import type { RabbitMqAdapter } from "@agent-pool/queue";
import {
  createRuntimeProvider,
  type E2BRuntimeClient,
  type FakeRuntimeProviderOptions,
  type RuntimeLifecycleLogger,
  type RuntimeProvider,
} from "@agent-pool/runtime";

import type { BackendInternalApiClient } from "./backend-client";
import type { CapacityLimiter } from "./capacity";
import type { ControlQueueConsumerRunResult } from "./control-consumer";
import { runControlQueueConsumerOnce } from "./control-consumer";
import { createE2BRuntimeClient } from "./e2b-client";
import type { OrchestratorMetricsRecorder } from "./metrics";
import type { ReconciliationClock, ReconciliationOnceResult } from "./reconciliation-loop";
import { runReconciliationOnce } from "./reconciliation-loop";
import type { RuntimeSandboxFinalizerOnceResult } from "./runtime-sandbox-finalizer";
import { runRuntimeSandboxFinalizerOnce } from "./runtime-sandbox-finalizer";
import { createRuntimeStarter } from "./runtime-starter";
import type { TaskQueueConsumerRunResult, TaskRuntimeStarter } from "./task-consumer";
import { runTaskQueueConsumerOnce } from "./task-consumer";

export type OrchestratorWorkerLoopScheduler = {
  readonly setInterval: (callback: () => void | Promise<unknown>, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

export type OrchestratorWorkerLoopState = {
  readonly running: boolean;
  readonly ticks: number;
  readonly failures: number;
  readonly inFlight: boolean;
  readonly lastError: string | null;
  readonly lastResult: unknown;
};

export type OrchestratorWorkerLoopsState = {
  readonly task: OrchestratorWorkerLoopState;
  readonly control: OrchestratorWorkerLoopState;
  readonly reconcile: OrchestratorWorkerLoopState;
  readonly finalizer: OrchestratorWorkerLoopState;
};

export type OrchestratorWorkerLoops = {
  readonly state: OrchestratorWorkerLoopsState;
  readonly tickTask: () => Promise<TaskQueueConsumerRunResult | null>;
  readonly tickControl: () => Promise<ControlQueueConsumerRunResult | null>;
  readonly tickReconcile: () => Promise<ReconciliationOnceResult | null>;
  readonly tickFinalizer: () => Promise<RuntimeSandboxFinalizerOnceResult | null>;
  readonly start: () => void;
  readonly stop: () => void;
};

export type OrchestratorWorkerLoopsOptions = {
  readonly config: AppConfig;
  readonly queue: RabbitMqAdapter;
  readonly backend: BackendInternalApiClient;
  readonly projectId?: string;
  readonly runtimeStarter?: TaskRuntimeStarter;
  readonly runtimeProviderInstance?: RuntimeProvider;
  readonly capacityLimiter?: CapacityLimiter;
  readonly metrics?: OrchestratorMetricsRecorder;
  readonly scheduler?: OrchestratorWorkerLoopScheduler;
  readonly clock?: ReconciliationClock;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly e2bRuntimeClient?: E2BRuntimeClient;
  readonly fakeRuntime?: FakeRuntimeProviderOptions;
  readonly runtimeLogger?: RuntimeLifecycleLogger;
  readonly onError?: (loop: "task" | "control" | "reconcile" | "finalizer", error: unknown) => void;
};

type WorkerLoop<TResult> = {
  readonly state: OrchestratorWorkerLoopState;
  readonly tick: () => Promise<TResult | null>;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createOrchestratorWorkerLoops(options: OrchestratorWorkerLoopsOptions): OrchestratorWorkerLoops {
  const projectId = options.projectId ?? options.config.controlPlane.smokeProjectId;
  const scheduler = options.scheduler ?? globalScheduler();
  const runtimeProvider = options.runtimeProviderInstance ?? createConfiguredRuntimeProvider(options);
  const runtimeStarter =
    options.runtimeStarter ??
    createRuntimeStarter({
      provider: runtimeProvider,
      githubTokenBroker: options.backend,
      requiresGitHubTokenBroker:
        options.config.controlPlane.runtimeProvider === "e2b" &&
        options.config.controlPlane.e2b.agentRunnerMode === "codex",
    });
  const task = createWorkerLoop<TaskQueueConsumerRunResult>({
    intervalMs: options.config.controlPlane.workerPollIntervalMs,
    scheduler,
    runOnce: () =>
      runTaskQueueConsumerOnce({
        projectId,
        queue: options.queue,
        backend: options.backend,
        runtimeStarter,
        runtimeProvider: options.config.controlPlane.runtimeProvider,
        capacityLimiter: options.capacityLimiter,
        metrics: options.metrics,
      }),
    onError: (error) => options.onError?.("task", error),
  });
  const control = createWorkerLoop<ControlQueueConsumerRunResult>({
    intervalMs: options.config.controlPlane.workerPollIntervalMs,
    scheduler,
    runOnce: () =>
      runControlQueueConsumerOnce({
        projectId,
        queue: options.queue,
        backend: options.backend,
        metrics: options.metrics,
      }),
    onError: (error) => options.onError?.("control", error),
  });
  const reconcile = createWorkerLoop<ReconciliationOnceResult>({
    intervalMs: options.config.controlPlane.reconcileIntervalMs,
    scheduler,
    runOnce: () =>
      runReconciliationOnce({
        projectId,
        backend: options.backend,
        runtimeProvider: options.config.controlPlane.runtimeProvider,
        clock: options.clock,
        metrics: options.metrics,
        claimSafetyNet: false,
      }),
    onError: (error) => options.onError?.("reconcile", error),
  });
  const finalizer = createWorkerLoop<RuntimeSandboxFinalizerOnceResult>({
    intervalMs: options.config.controlPlane.reconcileIntervalMs,
    scheduler,
    runOnce: () =>
      runRuntimeSandboxFinalizerOnce({
        projectId,
        backend: options.backend,
        runtimeProvider,
        clock: options.clock,
      }),
    onError: (error) => options.onError?.("finalizer", error),
  });

  return {
    get state(): OrchestratorWorkerLoopsState {
      return {
        task: task.state,
        control: control.state,
        reconcile: reconcile.state,
        finalizer: finalizer.state,
      };
    },
    tickTask: task.tick,
    tickControl: control.tick,
    tickReconcile: reconcile.tick,
    tickFinalizer: finalizer.tick,
    start(): void {
      task.start();
      control.start();
      reconcile.start();
      finalizer.start();
    },
    stop(): void {
      task.stop();
      control.stop();
      reconcile.stop();
      finalizer.stop();
    },
  };
}

function createConfiguredRuntimeProvider(options: OrchestratorWorkerLoopsOptions): RuntimeProvider {
  if (options.config.controlPlane.runtimeProvider === "e2b") {
    const e2b = options.config.controlPlane.e2b;
    const env = options.env ?? readProcessEnv();
    return createRuntimeProvider({
      kind: "e2b",
      e2b: {
        client: options.e2bRuntimeClient ?? createE2BRuntimeClient({ env, apiKeyEnvName: e2b.apiKeyEnvName }),
        config: e2b,
        env,
        secretEnvNames: e2b.allowedSecretEnvNames,
        logger: options.runtimeLogger,
      },
    });
  }

  if (options.config.controlPlane.runtimeProvider !== "fake") {
    return createRuntimeProvider({ kind: options.config.controlPlane.runtimeProvider });
  }

  return createRuntimeProvider({
    kind: "fake",
    fake: {
      bridgeRunMode: "after-startup",
      ...options.fakeRuntime,
      fetch: options.fakeRuntime?.fetch ?? options.fetch ?? fetch,
      logger: options.fakeRuntime?.logger ?? options.runtimeLogger,
    },
  });
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}

function createWorkerLoop<TResult>(options: {
  readonly intervalMs: number;
  readonly scheduler: OrchestratorWorkerLoopScheduler;
  readonly runOnce: () => Promise<TResult>;
  readonly onError?: (error: unknown) => void;
}): WorkerLoop<TResult> {
  const intervalMs = readPositiveInteger(options.intervalMs, "intervalMs");
  let handle: unknown | null = null;
  let inFlight: Promise<TResult | null> | null = null;
  let ticks = 0;
  let failures = 0;
  let lastError: string | null = null;
  let lastResult: unknown = null;

  const tick = async (): Promise<TResult | null> => {
    if (inFlight) return inFlight;

    inFlight = options
      .runOnce()
      .then((result) => {
        ticks += 1;
        lastResult = result;
        lastError = null;
        return result;
      })
      .catch((error: unknown) => {
        ticks += 1;
        failures += 1;
        lastError = error instanceof Error ? error.message : String(error);
        options.onError?.(error);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return {
    get state(): OrchestratorWorkerLoopState {
      return {
        running: handle !== null,
        ticks,
        failures,
        inFlight: inFlight !== null,
        lastError,
        lastResult,
      };
    },
    tick,
    start(): void {
      if (handle !== null) return;
      handle = options.scheduler.setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      options.scheduler.clearInterval(handle);
      handle = null;
    },
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function globalScheduler(): OrchestratorWorkerLoopScheduler {
  return {
    setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
