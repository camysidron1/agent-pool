import express, { type Express } from "express";

import { type AppConfig, loadConfig } from "@agent-pool/config";
import { SHARED_PACKAGE_NAME } from "@agent-pool/shared";

import type { ApiDatabaseConnection } from "./database";

export type ApiAppOptions = {
  readonly config?: AppConfig;
  readonly database?: ApiDatabaseConnection;
};

export function createApiApp(options: ApiAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const database = options.database;
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
    });
  });

  app.get("/metrics", (_request, response) => {
    response
      .status(200)
      .type("text/plain")
      .send(
        `# metrics placeholder for agent-pool-api\nagent_pool_api_info{shared_package="${SHARED_PACKAGE_NAME}"} 1\nagent_pool_api_database_connected ${database ? 1 : 0}\nagent_pool_api_database_applied_migrations ${database?.appliedMigrations.length ?? 0}\n`,
      );
  });

  return app;
}
