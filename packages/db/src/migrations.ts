import { mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { drizzle, type BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";

import type { WebSandboxDatabaseConfig } from "./ownership";

const TUI_DATABASE_SUFFIX = ".agent-pool/data/agent-pool.db";

export type SqlMigration = {
  readonly id: string;
  readonly description: string;
  readonly sql: readonly string[];
};

export type AppliedMigration = {
  readonly id: string;
  readonly description: string;
};

export type MigrationResult = {
  readonly path: string;
  readonly applied: readonly AppliedMigration[];
};

export type OpenWebSandboxDatabaseOptions = {
  readonly create?: boolean;
};

export type InitializeWebSandboxDatabaseOptions = OpenWebSandboxDatabaseOptions & {
  readonly migrations?: readonly SqlMigration[];
};

export type WebSandboxSqliteDatabase = Database;
export type WebSandboxDrizzleDatabase = BunSQLiteDatabase;

export const MIGRATION_TABLE_NAME = "web_sandbox_migrations" as const;

export const INITIAL_MIGRATION_ID = "0000_migration_harness" as const;

export const WEB_SANDBOX_MIGRATIONS: readonly SqlMigration[] = [
  {
    id: INITIAL_MIGRATION_ID,
    description: "Create web/sandbox migration metadata table",
    sql: [
      `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE_NAME} (
        id TEXT PRIMARY KEY NOT NULL,
        description TEXT NOT NULL,
        applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
    ],
  },
] as const;

export function createDrizzleDatabase(sqlite: WebSandboxSqliteDatabase): WebSandboxDrizzleDatabase {
  return drizzle(sqlite);
}

export function openWebSandboxDatabase(
  config: WebSandboxDatabaseConfig,
  options: OpenWebSandboxDatabaseOptions = {},
): WebSandboxSqliteDatabase {
  assertBackendOwnedConfig(config);
  assertNotTuiDatabasePath(config.path);
  ensureParentDirectory(config.path);

  return new Database(config.path, {
    create: options.create ?? true,
    strict: true,
  });
}

export function initializeWebSandboxDatabase(
  config: WebSandboxDatabaseConfig,
  options: InitializeWebSandboxDatabaseOptions = {},
): MigrationResult {
  const database = openWebSandboxDatabase(config, options);

  try {
    return migrateWebSandboxDatabase(database, {
      path: config.path,
      migrations: options.migrations,
    });
  } finally {
    database.close();
  }
}

export function migrateWebSandboxDatabase(
  database: WebSandboxSqliteDatabase,
  options: {
    readonly path?: string;
    readonly migrations?: readonly SqlMigration[];
  } = {},
): MigrationResult {
  const migrations = options.migrations ?? WEB_SANDBOX_MIGRATIONS;
  const applied: AppliedMigration[] = [];

  database.exec("PRAGMA foreign_keys = ON");
  ensureMigrationTable(database);

  for (const migration of migrations) {
    const alreadyApplied = database
      .query(`SELECT id FROM ${MIGRATION_TABLE_NAME} WHERE id = ?`)
      .get(migration.id);

    if (alreadyApplied) {
      continue;
    }

    database.exec("BEGIN IMMEDIATE");
    try {
      for (const statement of migration.sql) {
        database.exec(statement);
      }

      database
        .query(`INSERT INTO ${MIGRATION_TABLE_NAME} (id, description) VALUES (?, ?)`)
        .run(migration.id, migration.description);
      database.exec("COMMIT");
      applied.push({ id: migration.id, description: migration.description });
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
  }

  return {
    path: options.path ?? ":memory:",
    applied,
  };
}

function ensureMigrationTable(database: WebSandboxSqliteDatabase): void {
  database.exec(
    `CREATE TABLE IF NOT EXISTS ${MIGRATION_TABLE_NAME} (
      id TEXT PRIMARY KEY NOT NULL,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    )`,
  );
}

function assertBackendOwnedConfig(config: WebSandboxDatabaseConfig): void {
  if (config.owner !== "backend-api") {
    throw new Error(`web/sandbox database can only be opened by backend-api; received owner=${config.owner}`);
  }
}

function assertNotTuiDatabasePath(path: string): void {
  const normalized = resolve(path);
  const normalizedHomeRelativeTuiPath = resolveHomeRelativeTuiPath();

  if (normalized === normalizedHomeRelativeTuiPath || normalized.endsWith(TUI_DATABASE_SUFFIX)) {
    throw new Error("refusing to open existing agent-pool TUI database path for web/sandbox state");
  }
}

function resolveHomeRelativeTuiPath(): string {
  const home = readHomeDirectory();

  return home ? resolve(home, TUI_DATABASE_SUFFIX) : TUI_DATABASE_SUFFIX;
}

function readHomeDirectory(): string | undefined {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env?.HOME;
}

function ensureParentDirectory(path: string): void {
  if (path === ":memory:") {
    return;
  }

  mkdirSync(dirname(resolve(path)), { recursive: true });
}
