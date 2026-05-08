import { startOrchestratorService } from "./server";

export {
  createOrchestratorFetchHandler,
  startOrchestratorService,
  type BunServe,
  type OrchestratorServerOptions,
} from "./server";

const DEFAULT_ORCHESTRATOR_PORT = 3001;

if (isDirectRun()) {
  const port = readPort();

  startOrchestratorService({ port });
  console.info(`agent-pool-orchestrator listening on ${port}`);
}

function readPort(): number {
  const value = readProcessEnv().ORCHESTRATOR_PORT;

  if (!value) {
    return DEFAULT_ORCHESTRATOR_PORT;
  }

  const port = Number(value);

  return Number.isInteger(port) && port > 0 ? port : DEFAULT_ORCHESTRATOR_PORT;
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
