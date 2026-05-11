import { loadConfig } from "@agent-pool/config";

import { startOrchestratorService } from "./server";

export { checkBackendInternalHealth, type BackendHealthClientOptions, type BackendInternalHealthResult } from "./backend-client";
export {
  createOrchestratorFetchHandler,
  startOrchestratorService,
  type BunServe,
  type OrchestratorServerOptions,
} from "./server";

if (isDirectRun()) {
  const config = loadConfig(readProcessEnv());

  startOrchestratorService({ config, port: config.orchestrator.port });
  console.info(`agent-pool-orchestrator listening on ${config.orchestrator.port}`);
}

function isDirectRun(): boolean {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      argv?: readonly string[];
    };
  };
  const entrypoint = processLike.process?.argv?.[1];

  return typeof entrypoint === "string" && entrypoint.endsWith("apps/orchestrator/src/index.ts");
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}
