import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { DEFAULT_PROJECT_TASK_QUEUE } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

import type { CapacityLimiter } from "./capacity";
import { createOrchestratorMetrics, renderOrchestratorMetrics, type OrchestratorMetricsRecorder } from "./metrics";
import type { OrchestratorWorkerLoops, OrchestratorWorkerLoopsState } from "./worker-loops";

export type OrchestratorServerOptions = {
  readonly config?: AppConfig;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
  readonly capacityLimiter?: CapacityLimiter;
  readonly metrics?: OrchestratorMetricsRecorder;
  readonly workerLoops?: OrchestratorWorkerLoops;
};

export type BunServe = (options: {
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}) => unknown;

export function createOrchestratorFetchHandler(
  options: OrchestratorServerOptions = {},
): (request: Request) => Response {
  const config = options.config ?? loadConfig();
  const queue = options.queue ?? createRabbitMqAdapter(config.rabbitmq);
  const storage = options.storage ?? createStorageAdapter(config.storage);
  const metrics = options.metrics ?? createOrchestratorMetrics();

  return (request: Request): Response => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "agent-pool-orchestrator",
        authMode: config.authMode,
        backendInternalUrl: config.orchestrator.backendInternalUrl,
        adapters: {
          queue: {
            kind: queue.kind,
            connected: queue.connected,
          },
          storage: {
            kind: storage.kind,
            bucket: storage.bucket,
          },
        },
        controlPlane: {
          smokeEnabled: config.controlPlane.smokeEnabled,
          smokeProjectId: config.controlPlane.smokeProjectId,
          runtimeProvider: config.controlPlane.runtimeProvider,
          workerPollIntervalMs: config.controlPlane.workerPollIntervalMs,
          reconcileIntervalMs: config.controlPlane.reconcileIntervalMs,
        },
        workerLoops: readWorkerLoopsHealth(options.workerLoops),
      });
    }

    if (url.pathname === "/metrics") {
      return new Response(
        renderOrchestratorMetrics({
          taskQueueName: DEFAULT_PROJECT_TASK_QUEUE,
          queue,
          capacityLimiter: options.capacityLimiter,
          metrics,
          workerLoops: options.workerLoops,
        }),
        {
          headers: {
            "content-type": "text/plain; charset=utf-8",
          },
        },
      );
    }

    return Response.json({ error: "not found" }, { status: 404 });
  };
}

function readWorkerLoopsHealth(workerLoops: OrchestratorWorkerLoops | undefined) {
  return {
    initialized: Boolean(workerLoops),
    ...readWorkerLoopsState(workerLoops?.state),
  };
}

function readWorkerLoopsState(state: OrchestratorWorkerLoopsState | undefined) {
  return {
    task: readWorkerLoopState(state?.task),
    control: readWorkerLoopState(state?.control),
    reconcile: readWorkerLoopState(state?.reconcile),
  };
}

function readWorkerLoopState(state: OrchestratorWorkerLoopsState[keyof OrchestratorWorkerLoopsState] | undefined) {
  return {
    running: state?.running ?? false,
    inFlight: state?.inFlight ?? false,
    ticks: state?.ticks ?? 0,
    failures: state?.failures ?? 0,
    lastError: state?.lastError ?? null,
    lastResult: state?.lastResult ?? null,
  };
}

export function startOrchestratorService(options: OrchestratorServerOptions & { readonly port: number }): unknown {
  const bunServe = readBunServe();

  if (!bunServe) {
    throw new Error("Bun.serve is required to start the orchestrator service.");
  }

  return bunServe({
    port: options.port,
    fetch: createOrchestratorFetchHandler(options),
  });
}

function readBunServe(): BunServe | undefined {
  const bunLike = globalThis as typeof globalThis & {
    Bun?: {
      serve?: BunServe;
    };
  };

  return bunLike.Bun?.serve;
}
