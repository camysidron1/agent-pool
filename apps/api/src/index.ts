import { loadConfig } from "@agent-pool/config";

import { createApiApp } from "./app";
import { openApiDatabase } from "./database";

export { createApiApp, type ApiAppOptions } from "./app";
export {
  API_DATABASE_PATH_ENV,
  DEFAULT_API_DATABASE_RELATIVE_PATH,
  createApiDatabaseConfig,
  openApiDatabase,
  resolveApiDatabasePath,
  type ApiDatabaseConnection,
  type ApiDatabaseEnv,
} from "./database";

if (isDirectRun()) {
  const env = readProcessEnv();
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const app = createApiApp({ config, database });
  const server = app.listen(config.backend.port, () => {
    console.info(`agent-pool-api listening on ${config.backend.port}`);
  }) as { close: () => void };

  registerShutdown(() => {
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
