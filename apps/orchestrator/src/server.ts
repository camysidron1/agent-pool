import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { DEFAULT_PROJECT_TASK_QUEUE } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

export type OrchestratorServerOptions = {
  readonly config?: AppConfig;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
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
      return new Response(
        `# metrics placeholder for agent-pool-orchestrator\nagent_pool_orchestrator_info{task_queue="${DEFAULT_PROJECT_TASK_QUEUE}"} 1\nagent_pool_orchestrator_backend_internal_configured 1\nagent_pool_orchestrator_queue_adapter_initialized 1\nagent_pool_orchestrator_storage_adapter_initialized 1\n`,
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
