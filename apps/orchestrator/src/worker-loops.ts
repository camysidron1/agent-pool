import type { AppConfig } from "@agent-pool/config";
import type { RabbitMqAdapter } from "@agent-pool/queue";
import type { E2BRuntimeClient, FakeRuntimeProviderOptions } from "@agent-pool/runtime";

import type { BackendInternalApiClient } from "./backend-client";
import type { CapacityLimiter } from "./capacity";
import type { ControlQueueConsumerRunResult } from "./control-consumer";
import { runControlQueueConsumerOnce } from "./control-consumer";
import { createE2BRuntimeClient } from "./e2b-client";
import type { OrchestratorMetricsRecorder } from "./metrics";
import type { ReconciliationClock, ReconciliationOnceResult } from "./reconciliation-loop";
import { runReconciliationOnce } from "./reconciliation-loop";
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
};

export type OrchestratorWorkerLoops = {
  readonly state: OrchestratorWorkerLoopsState;
  readonly tickTask: () => Promise<TaskQueueConsumerRunResult | null>;
  readonly tickControl: () => Promise<ControlQueueConsumerRunResult | null>;
  readonly tickReconcile: () => Promise<ReconciliationOnceResult | null>;
  readonly start: () => void;
  readonly stop: () => void;
};

export type OrchestratorWorkerLoopsOptions = {
  readonly config: AppConfig;
  readonly queue: RabbitMqAdapter;
  readonly backend: BackendInternalApiClient;
  readonly projectId?: string;
  readonly runtimeStarter?: TaskRuntimeStarter;
  readonly capacityLimiter?: CapacityLimiter;
  readonly metrics?: OrchestratorMetricsRecorder;
  readonly scheduler?: OrchestratorWorkerLoopScheduler;
  readonly clock?: ReconciliationClock;
  readonly fetch?: typeof fetch;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly e2bRuntimeClient?: E2BRuntimeClient;
  readonly fakeRuntime?: FakeRuntimeProviderOptions;
  readonly onError?: (loop: "task" | "control" | "reconcile", error: unknown) => void;
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
  const runtimeStarter = options.runtimeStarter ?? createConfiguredRuntimeStarter(options);
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

  return {
    get state(): OrchestratorWorkerLoopsState {
      return {
        task: task.state,
        control: control.state,
        reconcile: reconcile.state,
      };
    },
    tickTask: task.tick,
    tickControl: control.tick,
    tickReconcile: reconcile.tick,
    start(): void {
      task.start();
      control.start();
      reconcile.start();
    },
    stop(): void {
      task.stop();
      control.stop();
      reconcile.stop();
    },
  };
}

function createConfiguredRuntimeStarter(options: OrchestratorWorkerLoopsOptions): TaskRuntimeStarter {
  if (options.config.controlPlane.runtimeProvider === "e2b") {
    const e2b = options.config.controlPlane.e2b;
    const env = options.env ?? readProcessEnv();
    return createRuntimeStarter({
      providerKind: "e2b",
      e2b: {
        client: options.e2bRuntimeClient ?? createE2BRuntimeClient({ env, apiKeyEnvName: e2b.apiKeyEnvName }),
        config: e2b,
        env,
        secretEnvNames: e2b.allowedSecretEnvNames,
      },
    });
  }

  if (options.config.controlPlane.runtimeProvider !== "fake") {
    return createRuntimeStarter({ providerKind: options.config.controlPlane.runtimeProvider });
  }

  return createRuntimeStarter({
    providerKind: "fake",
    fake: {
      bridgeRunMode: "after-startup",
      ...options.fakeRuntime,
      fetch: options.fakeRuntime?.fetch ?? options.fetch ?? fetch,
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
