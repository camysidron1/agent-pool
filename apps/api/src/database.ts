import { join, resolve } from "node:path";

import {
  createDrizzleDatabase,
  createWebSandboxDatabaseConfig,
  migrateWebSandboxDatabase,
  openWebSandboxDatabase,
  type AppliedMigration,
  type WebSandboxDatabaseConfig,
  type WebSandboxDrizzleDatabase,
  type WebSandboxSqliteDatabase,
} from "@agent-pool/db";

export type ApiDatabaseEnv = Readonly<Record<string, string | undefined>>;

export type ApiDatabaseConnection = {
  readonly path: string;
  readonly sqlite: WebSandboxSqliteDatabase;
  readonly drizzle: WebSandboxDrizzleDatabase;
  readonly appliedMigrations: readonly AppliedMigration[];
  readonly close: () => void;
};

export const API_DATABASE_PATH_ENV = "AGENT_POOL_WEB_SANDBOX_DB_PATH" as const;
export const DEFAULT_API_DATABASE_RELATIVE_PATH = join(".agent-pool", "web-sandbox", "web-sandbox.db");

const LEGACY_TUI_DATABASE_RELATIVE_PATH = join(".agent-pool", "data", "agent-pool.db");

export function createApiDatabaseConfig(env: ApiDatabaseEnv = readProcessEnv()): WebSandboxDatabaseConfig {
  return createWebSandboxDatabaseConfig(resolveApiDatabasePath(env));
}

export function resolveApiDatabasePath(env: ApiDatabaseEnv = readProcessEnv()): string {
  const explicitPath = env[API_DATABASE_PATH_ENV]?.trim();
  const path = explicitPath || resolveDefaultApiDatabasePath(env);

  assertNotLegacyTuiDatabasePath(path, env);

  return path;
}

export function openApiDatabase(env: ApiDatabaseEnv = readProcessEnv()): ApiDatabaseConnection {
  const config = createApiDatabaseConfig(env);
  const sqlite = openWebSandboxDatabase(config);

  try {
    const result = migrateWebSandboxDatabase(sqlite, { path: config.path });
    let closed = false;

    return {
      path: result.path,
      sqlite,
      drizzle: createDrizzleDatabase(sqlite),
      appliedMigrations: result.applied,
      close() {
        if (!closed) {
          closed = true;
          sqlite.close();
        }
      },
    };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

function resolveDefaultApiDatabasePath(env: ApiDatabaseEnv): string {
  const home = env.HOME?.trim();

  if (home) {
    return join(home, DEFAULT_API_DATABASE_RELATIVE_PATH);
  }

  return resolve(DEFAULT_API_DATABASE_RELATIVE_PATH);
}

function assertNotLegacyTuiDatabasePath(path: string, env: ApiDatabaseEnv): void {
  const normalized = resolve(path);
  const home = env.HOME?.trim();
  const normalizedHomeTuiPath = home ? resolve(home, LEGACY_TUI_DATABASE_RELATIVE_PATH) : undefined;

  if (normalizedHomeTuiPath && normalized === normalizedHomeTuiPath) {
    throw new Error("refusing to use existing agent-pool TUI database path for web/sandbox state");
  }

  if (normalized.endsWith(LEGACY_TUI_DATABASE_RELATIVE_PATH)) {
    throw new Error("refusing to use existing agent-pool TUI database path for web/sandbox state");
  }
}

function readProcessEnv(): ApiDatabaseEnv {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: ApiDatabaseEnv;
    };
  };

  return processLike.process?.env ?? {};
}
