import { loadConfig } from "@agent-pool/config";

import { createApiApp } from "./app";
import { openApiDatabase } from "./database";

export { createApiApp, type ApiAppOptions } from "./app";

const DEFAULT_API_PORT = 3000;

if (isDirectRun()) {
  const env = readProcessEnv();
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const app = createApiApp({ config, database });
  const port = readPort();

  app.listen(port, () => {
    console.info(`agent-pool-api listening on ${port}`);
  });
}

function readPort(): number {
  const value = readProcessEnv().API_PORT;

  if (!value) {
    return DEFAULT_API_PORT;
  }

  const port = Number(value);

  return Number.isInteger(port) && port > 0 ? port : DEFAULT_API_PORT;
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
