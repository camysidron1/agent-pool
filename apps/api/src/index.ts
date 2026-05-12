import { loadConfig } from "@agent-pool/config";
import { createRabbitMqManagementHttpAdapter } from "@agent-pool/queue";

import { createApiApp } from "./app";
import { openApiDatabase } from "./database";
import { createOutboxPublisher } from "./outbox-publisher";
import { createOutboxPublisherLoop } from "./outbox-publisher-loop";

export { createApiApp, type ApiAppOptions } from "./app";
export {
  createApiBackendServices,
  type ApiBackendServicesOptions,
  type CreateProjectWithQueuesResult,
} from "./backend-services";
export {
  API_DATABASE_PATH_ENV,
  DEFAULT_API_DATABASE_RELATIVE_PATH,
  createApiDatabaseConfig,
  openApiDatabase,
  resolveApiDatabasePath,
  type ApiDatabaseConnection,
  type ApiDatabaseEnv,
} from "./database";
export {
  createOutboxPublisher,
  type FailedOutboxRecord,
  type OutboxPublisherOptions,
  type OutboxPublisher,
  type PublishQueuedOutboxOptions,
  type PublishQueuedOutboxResult,
  type PublishedOutboxRecord,
} from "./outbox-publisher";
export {
  createOutboxPublisherLoop,
  type OutboxPublisherLoop,
  type OutboxPublisherLoopOptions,
  type OutboxPublisherLoopScheduler,
  type OutboxPublisherLoopState,
} from "./outbox-publisher-loop";

if (isDirectRun()) {
  const env = readProcessEnv();
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const queue = createRabbitMqManagementHttpAdapter(config.rabbitmq);
  const outboxPublisher = createOutboxPublisher({ database, queue });
  const outboxPublisherLoop = createOutboxPublisherLoop({
    publisher: outboxPublisher,
    intervalMs: config.controlPlane.outboxPublishIntervalMs,
  });
  const app = createApiApp({ config, database, queue, outboxPublisher, outboxPublisherLoop });
  const server = app.listen(config.backend.port, () => {
    console.info(`agent-pool-api listening on ${config.backend.port}`);
  }) as { close: () => void };
  outboxPublisherLoop.start();

  registerShutdown(() => {
    outboxPublisherLoop.stop();
    database.close();
    server.close();
  });
}

function isDirectRun(): boolean {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      argv?: readonly string[];
    };
  };
  const entrypoint = processLike.process?.argv?.[1];

  return typeof entrypoint === "string" && entrypoint.endsWith("apps/api/src/index.ts");
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
