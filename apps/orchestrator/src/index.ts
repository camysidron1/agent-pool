import { loadConfig } from "@agent-pool/config";

import { startOrchestratorService } from "./server";

export {
  checkBackendInternalHealth,
  createBackendInternalApiClient,
  type BackendEvent,
  type BackendHealthClientOptions,
  type BackendInternalApiClient,
  type BackendInternalClientOptions,
  type BackendInternalHealthResult,
  type BackendInternalHttpResult,
  type BackendOutbox,
  type ClaimNextCommandInput,
  type ClaimNextCommandResponse,
  type ClaimNextTaskInput,
  type ClaimNextTaskResponse,
  type CommandReportInput,
  type CommandReportResponse,
  type ReconcileInput,
  type ReconcileResponse,
  type SessionHeartbeatInput,
  type SessionHeartbeatResponse,
  type StartupReportInput,
  type StartupReportResponse,
} from "./backend-client";
export {
  createOrchestratorFetchHandler,
  startOrchestratorService,
  type BunServe,
  type OrchestratorServerOptions,
} from "./server";
export {
  runTaskQueueConsumerOnce,
  type TaskQueueConsumerBackend,
  type TaskQueueConsumerOptions,
  type TaskQueueConsumerRunResult,
  type TaskRuntimeStarter,
  type TaskRuntimeStartupRequest,
  type TaskRuntimeStartupResult,
} from "./task-consumer";

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
