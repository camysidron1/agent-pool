import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { DEFAULT_PROJECT_TASK_QUEUE } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

import type { CapacityLimiter } from "./capacity";
import { createOrchestratorMetrics, renderOrchestratorMetrics, type OrchestratorMetricsRecorder } from "./metrics";

export type OrchestratorServerOptions = {
  readonly config?: AppConfig;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
  readonly capacityLimiter?: CapacityLimiter;
  readonly metrics?: OrchestratorMetricsRecorder;
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
      });
    }

    if (url.pathname === "/metrics") {
      return new Response(renderOrchestratorMetrics({ taskQueueName: DEFAULT_PROJECT_TASK_QUEUE, queue, capacityLimiter: options.capacityLimiter, metrics }), {
        headers: {
          "content-type": "text/plain; charset=utf-8",
        },
      });
    }

    return Response.json({ error: "not found" }, { status: 404 });
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
