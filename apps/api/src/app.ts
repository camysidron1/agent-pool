import express, { type Express } from "express";

import { verifyServiceTokenValue } from "@agent-pool/auth";
import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { SHARED_PACKAGE_NAME } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

import type { ApiDatabaseConnection } from "./database";

export type ApiAppOptions = {
  readonly config?: AppConfig;
  readonly database?: ApiDatabaseConnection;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
};

export function createApiApp(options: ApiAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const database = options.database;
  const queue = options.queue ?? createRabbitMqAdapter(config.rabbitmq);
  const storage = options.storage ?? createStorageAdapter(config.storage);
  const app = express();

  app.get("/health", (_request, response) => {
    response.status(200).json({
      ok: true,
      service: "agent-pool-api",
      authMode: config.authMode,
      database: {
        connected: Boolean(database),
        path: database?.path ?? null,
        appliedMigrations: database?.appliedMigrations.length ?? 0,
      },
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
  });

  app.get("/internal/health", (request, response) => {
    const headers = (request as { headers?: Record<string, string | readonly string[] | undefined> }).headers ?? {};
    const headerValue = headers[config.serviceToken.headerName];
    const auth = verifyServiceTokenValue(Array.isArray(headerValue) ? headerValue[0] : headerValue, config.serviceToken);

    if (!auth.ok) {
      response.status(auth.reason === "missing" ? 401 : 403).json({
        ok: false,
        error: "invalid_internal_service_token",
        reason: auth.reason,
      });
      return;
    }

    response.status(200).json({
      ok: true,
      service: "agent-pool-api",
      subject: auth.subject,
      database: {
        connected: Boolean(database),
        appliedMigrations: database?.appliedMigrations.length ?? 0,
      },
      adapters: {
        queue: queue.kind,
        storage: storage.kind,
      },
    });
  });

  app.get("/metrics", (_request, response) => {
    response
      .status(200)
      .type("text/plain")
      .send(
        `# metrics placeholder for agent-pool-api\nagent_pool_api_info{shared_package="${SHARED_PACKAGE_NAME}"} 1\nagent_pool_api_database_connected ${database ? 1 : 0}\nagent_pool_api_database_applied_migrations ${database?.appliedMigrations.length ?? 0}\nagent_pool_api_queue_adapter_initialized 1\nagent_pool_api_storage_adapter_initialized 1\n`,
      );
  });

  return app;
}
