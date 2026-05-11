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
export const CORE_PROJECT_TASK_SCHEMA_MIGRATION_ID = "0001_core_project_task_schema" as const;
export const SESSION_SCHEMA_MIGRATION_ID = "0002_session_schema" as const;

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
  {
    id: CORE_PROJECT_TASK_SCHEMA_MIGRATION_ID,
    description: "Create projects, tasks, and task dependency schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
        task_display_sequence INTEGER NOT NULL DEFAULT 0 CHECK (task_display_sequence >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS projects_slug_unique ON projects (slug)",
      `CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        display_id INTEGER NOT NULL CHECK (display_id > 0),
        title TEXT NOT NULL,
        description TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'blocked', 'completed', 'failed')),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (project_id, display_id),
        UNIQUE (project_id, id)
      )`,
      "CREATE INDEX IF NOT EXISTS tasks_project_status_idx ON tasks (project_id, status)",
      `CREATE TABLE IF NOT EXISTS task_dependencies (
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT NOT NULL,
        depends_on_task_id TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        PRIMARY KEY (project_id, task_id, depends_on_task_id),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, depends_on_task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        CHECK (task_id <> depends_on_task_id)
      )`,
      "CREATE INDEX IF NOT EXISTS task_dependencies_depends_on_idx ON task_dependencies (project_id, depends_on_task_id)",
    ],
  },
  {
    id: SESSION_SCHEMA_MIGRATION_ID,
    description: "Create sessions and session snapshot schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT NOT NULL,
        attempt_number INTEGER NOT NULL CHECK (attempt_number > 0),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'starting', 'running', 'succeeded', 'failed', 'canceled')),
        runtime_provider TEXT,
        runtime_session_id TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        started_at TEXT,
        ended_at TEXT,
        UNIQUE (project_id, task_id, attempt_number),
        UNIQUE (project_id, id),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS sessions_project_status_idx ON sessions (project_id, status)",
      `CREATE TABLE IF NOT EXISTS session_snapshots (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        session_id TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'system' CHECK (kind IN ('manual', 'retry_base', 'system')),
        provider_snapshot_id TEXT,
        label TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS session_snapshots_session_idx ON session_snapshots (project_id, session_id)",
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
