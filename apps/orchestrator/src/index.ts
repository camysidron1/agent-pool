import { loadConfig } from "@agent-pool/config";
import { createRabbitMqManagementHttpAdapter } from "@agent-pool/queue";

import { createBackendInternalApiClient } from "./backend-client";
import { createCapacityLimiter } from "./capacity";
import { createOrchestratorMetrics } from "./metrics";
import { startOrchestratorService } from "./server";
import { createOrchestratorWorkerLoops } from "./worker-loops";

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
  type BackendBridgeSessionConfig,
  type ClaimedTaskSession,
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
  createCapacityLimiter,
  type CapacityLease,
  type CapacityLimiter,
  type CapacityLimiterOptions,
} from "./capacity";
export {
  runControlQueueConsumerOnce,
  unsupportedCommandHandler,
  type CommandHandler,
  type CommandHandlingRequest,
  type CommandHandlingResult,
  type ControlQueueConsumerBackend,
  type ControlQueueConsumerOptions,
  type ControlQueueConsumerRunResult,
} from "./control-consumer";
export {
  createOrchestratorFetchHandler,
  startOrchestratorService,
  type BunServe,
  type OrchestratorServerOptions,
} from "./server";
export {
  createE2BRuntimeClient,
  serializeE2BCommand,
  type CreateE2BRuntimeClientOptions,
  type E2BSdkLoader,
} from "./e2b-client";
export {
  createOrchestratorMetrics,
  renderOrchestratorMetrics,
  type OrchestratorMetricsCounters,
  type OrchestratorMetricsRecorder,
  type RenderOrchestratorMetricsOptions,
} from "./metrics";
export {
  createQueueDecisionPolicy,
  type QueueDecisionPolicy,
  type QueueDecisionPolicyOptions,
} from "./queue-policy";
export {
  createReconciliationLoop,
  runReconciliationOnce,
  type ReconciliationBackend,
  type ReconciliationClock,
  type ReconciliationLoop,
  type ReconciliationLoopOptions,
  type ReconciliationOnceResult,
  type ReconciliationOptions,
  type ReconciliationScheduler,
} from "./reconciliation-loop";
export {
  createRuntimeStarter,
  type RuntimeStarterOptions,
} from "./runtime-starter";
export {
  runTaskQueueConsumerOnce,
  type TaskQueueConsumerBackend,
  type TaskQueueConsumerOptions,
  type TaskQueueConsumerRunResult,
  type TaskRuntimeStarter,
  type TaskRuntimeStartupRequest,
  type TaskRuntimeStartupResult,
} from "./task-consumer";
export {
  createOrchestratorWorkerLoops,
  type OrchestratorWorkerLoopScheduler,
  type OrchestratorWorkerLoops,
  type OrchestratorWorkerLoopsOptions,
  type OrchestratorWorkerLoopsState,
  type OrchestratorWorkerLoopState,
} from "./worker-loops";

if (isDirectRun()) {
  const env = readProcessEnv();
  const config = loadConfig(env);
  const queue = createRabbitMqManagementHttpAdapter(config.rabbitmq);
  const backend = createBackendInternalApiClient({ config });
  const capacityLimiter = createCapacityLimiter({ maxConcurrent: 1 });
  const metrics = createOrchestratorMetrics();
  const workerLoops = createOrchestratorWorkerLoops({ config, queue, backend, capacityLimiter, metrics, env });

  const server = startOrchestratorService({ config, port: config.orchestrator.port, queue, capacityLimiter, metrics, workerLoops });
  workerLoops.start();
  registerShutdown(() => {
    workerLoops.stop();
    stopServer(server);
  });
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

function registerShutdown(close: () => void): void {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      once?: (event: string, listener: () => void) => void;
    };
  };

  processLike.process?.once?.("SIGINT", close);
  processLike.process?.once?.("SIGTERM", close);
}

function stopServer(server: unknown): void {
  if (server && typeof server === "object" && "stop" in server && typeof server.stop === "function") {
    server.stop();
  }
}
