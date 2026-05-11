import { type AppConfig, loadConfig } from "@agent-pool/config";
import { DEFAULT_PROJECT_TASK_QUEUE } from "@agent-pool/shared";

export type OrchestratorServerOptions = {
  readonly config?: AppConfig;
};

export type BunServe = (options: {
  readonly port: number;
  readonly fetch: (request: Request) => Response | Promise<Response>;
}) => unknown;

export function createOrchestratorFetchHandler(
  options: OrchestratorServerOptions = {},
): (request: Request) => Response {
  const config = options.config ?? loadConfig();

  return (request: Request): Response => {
    const url = new URL(request.url);

    if (url.pathname === "/health") {
      return Response.json({
        ok: true,
        service: "agent-pool-orchestrator",
        authMode: config.authMode,
        backendInternalUrl: config.orchestrator.backendInternalUrl,
      });
    }

    if (url.pathname === "/metrics") {
      return new Response(
        `# metrics placeholder for agent-pool-orchestrator\nagent_pool_orchestrator_info{task_queue="${DEFAULT_PROJECT_TASK_QUEUE}"} 1\nagent_pool_orchestrator_backend_internal_configured 1\n`,
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
