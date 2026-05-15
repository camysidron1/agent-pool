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
export const ORCHESTRATOR_COMMAND_SCHEMA_MIGRATION_ID = "0003_orchestrator_command_schema" as const;
export const ARTIFACT_EVENT_OUTBOX_SCHEMA_MIGRATION_ID = "0004_artifact_event_outbox_schema" as const;
export const CHAT_STEERING_NOTE_SCHEMA_MIGRATION_ID = "0005_chat_steering_note_schema" as const;
export const STORAGE_LOG_SCHEMA_MIGRATION_ID = "0006_storage_log_schema" as const;
export const FINAL_RESPONSE_SCHEMA_MIGRATION_ID = "0007_final_response_schema" as const;
export const SESSION_HEARTBEAT_SCHEMA_MIGRATION_ID = "0008_session_heartbeat_schema" as const;
export const BRIDGE_SESSION_CALLBACK_SCHEMA_MIGRATION_ID = "0009_bridge_session_callback_schema" as const;
export const TASK_RUNTIME_SOURCE_SCHEMA_MIGRATION_ID = "0010_task_runtime_source_schema" as const;
export const TASK_PRIORITY_SCHEMA_MIGRATION_ID = "0011_task_priority_schema" as const;
export const RUNTIME_SANDBOX_LIFECYCLE_SCHEMA_MIGRATION_ID = "0012_runtime_sandbox_lifecycle_schema" as const;
export const PACKAGE_REGISTRY_AUDIT_SCHEMA_MIGRATION_ID = "0013_package_registry_audit_schema" as const;

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
  {
    id: ORCHESTRATOR_COMMAND_SCHEMA_MIGRATION_ID,
    description: "Create durable orchestrator command schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS orchestrator_commands (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        type TEXT NOT NULL CHECK (type IN ('start', 'stop', 'cancel', 'retry', 'cleanup', 'interrupt', 'steer')),
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'succeeded', 'failed', 'canceled')),
        payload_json TEXT NOT NULL DEFAULT '{}',
        error_message TEXT,
        requested_by TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        claimed_at TEXT,
        completed_at TEXT,
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS orchestrator_commands_project_id_unique ON orchestrator_commands (project_id, id)",
      "CREATE INDEX IF NOT EXISTS orchestrator_commands_project_status_idx ON orchestrator_commands (project_id, status)",
      "CREATE INDEX IF NOT EXISTS orchestrator_commands_project_type_idx ON orchestrator_commands (project_id, type)",
      "CREATE INDEX IF NOT EXISTS orchestrator_commands_task_idx ON orchestrator_commands (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS orchestrator_commands_session_idx ON orchestrator_commands (project_id, session_id)",
    ],
  },
  {
    id: ARTIFACT_EVENT_OUTBOX_SCHEMA_MIGRATION_ID,
    description: "Create artifact, event, and outbox schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS artifacts (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('final_response_url', 'document', 'log', 'file', 'link')),
        uri TEXT NOT NULL,
        title TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS artifacts_project_kind_idx ON artifacts (project_id, kind)",
      "CREATE INDEX IF NOT EXISTS artifacts_task_idx ON artifacts (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS artifacts_session_idx ON artifacts (project_id, session_id)",
      `CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        command_id TEXT,
        type TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, command_id) REFERENCES orchestrator_commands(project_id, id) ON DELETE SET NULL ON UPDATE CASCADE
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS events_project_id_unique ON events (project_id, id)",
      "CREATE INDEX IF NOT EXISTS events_project_created_idx ON events (project_id, created_at)",
      "CREATE INDEX IF NOT EXISTS events_type_idx ON events (project_id, type)",
      "CREATE INDEX IF NOT EXISTS events_task_idx ON events (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS events_session_idx ON events (project_id, session_id)",
      "CREATE INDEX IF NOT EXISTS events_command_idx ON events (project_id, command_id)",
      `CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        event_id TEXT,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'published', 'failed')),
        routing_key TEXT NOT NULL,
        payload_json TEXT NOT NULL DEFAULT '{}',
        attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
        last_error TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        published_at TEXT,
        FOREIGN KEY (project_id, event_id) REFERENCES events(project_id, id) ON DELETE SET NULL ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS outbox_status_created_idx ON outbox (status, created_at)",
      "CREATE INDEX IF NOT EXISTS outbox_project_status_idx ON outbox (project_id, status)",
    ],
  },
  {
    id: CHAT_STEERING_NOTE_SCHEMA_MIGRATION_ID,
    description: "Create chat, steering, and note schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        role TEXT NOT NULL CHECK (role IN ('operator', 'assistant', 'system')),
        body TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS chat_messages_project_created_idx ON chat_messages (project_id, created_at)",
      "CREATE INDEX IF NOT EXISTS chat_messages_task_idx ON chat_messages (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS chat_messages_session_idx ON chat_messages (project_id, session_id)",
      `CREATE TABLE IF NOT EXISTS steering_messages (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        command_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'delivered', 'failed', 'canceled')),
        error_message TEXT,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        delivered_at TEXT,
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, command_id) REFERENCES orchestrator_commands(project_id, id) ON DELETE SET NULL ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS steering_messages_project_status_idx ON steering_messages (project_id, status)",
      "CREATE INDEX IF NOT EXISTS steering_messages_task_idx ON steering_messages (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS steering_messages_session_idx ON steering_messages (project_id, session_id)",
      `CREATE TABLE IF NOT EXISTS notes (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        author_id TEXT,
        body TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS notes_project_created_idx ON notes (project_id, created_at)",
      "CREATE INDEX IF NOT EXISTS notes_task_idx ON notes (project_id, task_id)",
      "CREATE INDEX IF NOT EXISTS notes_session_idx ON notes (project_id, session_id)",
    ],
  },
  {
    id: STORAGE_LOG_SCHEMA_MIGRATION_ID,
    description: "Create storage object and log stream metadata schema",
    sql: [
      "CREATE UNIQUE INDEX IF NOT EXISTS artifacts_project_id_unique ON artifacts (project_id, id)",
      `CREATE TABLE IF NOT EXISTS storage_objects (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        artifact_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('artifact', 'log', 'blob')),
        provider TEXT NOT NULL DEFAULT 'local',
        bucket TEXT,
        object_key TEXT NOT NULL,
        content_type TEXT,
        size_bytes INTEGER CHECK (size_bytes IS NULL OR size_bytes >= 0),
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, artifact_id) REFERENCES artifacts(project_id, id) ON DELETE SET NULL ON UPDATE CASCADE
      )`,
      "CREATE UNIQUE INDEX IF NOT EXISTS storage_objects_provider_key_unique ON storage_objects (provider, bucket, object_key)",
      "CREATE INDEX IF NOT EXISTS storage_objects_project_kind_idx ON storage_objects (project_id, kind)",
      `CREATE TABLE IF NOT EXISTS log_streams (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT,
        session_id TEXT,
        storage_object_id TEXT,
        kind TEXT NOT NULL DEFAULT 'combined' CHECK (kind IN ('stdout', 'stderr', 'combined', 'system')),
        byte_offset INTEGER NOT NULL DEFAULT 0 CHECK (byte_offset >= 0),
        line_count INTEGER NOT NULL DEFAULT 0 CHECK (line_count >= 0),
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (storage_object_id) REFERENCES storage_objects(id) ON DELETE SET NULL ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS log_streams_session_idx ON log_streams (project_id, session_id)",
      "CREATE INDEX IF NOT EXISTS log_streams_task_idx ON log_streams (project_id, task_id)",
    ],
  },
  {
    id: FINAL_RESPONSE_SCHEMA_MIGRATION_ID,
    description: "Add final assistant response persistence fields",
    sql: [
      "ALTER TABLE sessions ADD COLUMN final_response_text TEXT",
      "ALTER TABLE sessions ADD COLUMN final_response_metadata_json TEXT",
      "ALTER TABLE sessions ADD COLUMN final_response_recorded_at TEXT",
    ],
  },
  {
    id: SESSION_HEARTBEAT_SCHEMA_MIGRATION_ID,
    description: "Add session heartbeat reconciliation fields",
    sql: [
      "ALTER TABLE sessions ADD COLUMN last_heartbeat_at TEXT",
      "ALTER TABLE sessions ADD COLUMN heartbeat_status TEXT NOT NULL DEFAULT 'fresh' CHECK (heartbeat_status IN ('fresh', 'stale', 'lost'))",
      "ALTER TABLE sessions ADD COLUMN stale_at TEXT",
      "ALTER TABLE sessions ADD COLUMN lost_at TEXT",
      "CREATE INDEX IF NOT EXISTS sessions_heartbeat_status_idx ON sessions (project_id, heartbeat_status, last_heartbeat_at)",
    ],
  },
  {
    id: BRIDGE_SESSION_CALLBACK_SCHEMA_MIGRATION_ID,
    description: "Add bridge session callback token fields",
    sql: [
      "ALTER TABLE sessions ADD COLUMN bridge_callback_base_url TEXT",
      "ALTER TABLE sessions ADD COLUMN bridge_session_token_header TEXT",
      "ALTER TABLE sessions ADD COLUMN bridge_session_token TEXT",
    ],
  },
  {
    id: TASK_RUNTIME_SOURCE_SCHEMA_MIGRATION_ID,
    description: "Add task runtime source metadata field",
    sql: ["ALTER TABLE tasks ADD COLUMN runtime_source_json TEXT"],
  },
  {
    id: TASK_PRIORITY_SCHEMA_MIGRATION_ID,
    description: "Add task priority ordering field",
    sql: [
      "ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0",
      "CREATE INDEX IF NOT EXISTS tasks_project_priority_idx ON tasks (project_id, status, priority, display_id)",
    ],
  },
  {
    id: RUNTIME_SANDBOX_LIFECYCLE_SCHEMA_MIGRATION_ID,
    description: "Add runtime sandbox cleanup and snapshot lifecycle schema",
    sql: [
      "ALTER TABLE sessions ADD COLUMN source_snapshot_id TEXT",
      `CREATE TABLE IF NOT EXISTS runtime_sandboxes (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        provider_sandbox_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'terminal', 'cleanup_claimed', 'cleanup_succeeded', 'cleanup_failed')),
        snapshot_status TEXT NOT NULL DEFAULT 'not_required' CHECK (snapshot_status IN ('not_required', 'pending', 'claimed', 'succeeded', 'failed', 'skipped')),
        cleanup_attempts INTEGER NOT NULL DEFAULT 0 CHECK (cleanup_attempts >= 0),
        snapshot_attempts INTEGER NOT NULL DEFAULT 0 CHECK (snapshot_attempts >= 0),
        cleanup_claimed_at TEXT,
        cleanup_completed_at TEXT,
        snapshot_claimed_at TEXT,
        snapshot_completed_at TEXT,
        terminal_at TEXT,
        last_error_message TEXT,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        UNIQUE (project_id, session_id),
        UNIQUE (provider, provider_sandbox_id),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS runtime_sandboxes_project_status_idx ON runtime_sandboxes (project_id, status)",
      "CREATE INDEX IF NOT EXISTS runtime_sandboxes_session_idx ON runtime_sandboxes (project_id, session_id)",
      "ALTER TABLE session_snapshots ADD COLUMN provider TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('creating', 'ready', 'failed', 'expired', 'delete_claimed', 'deleted', 'delete_failed'))",
      "ALTER TABLE session_snapshots ADD COLUMN source_runtime_sandbox_id TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN source_session_id TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN provider_sandbox_id TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN expires_at TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN delete_claimed_at TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN deleted_at TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN last_used_at TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN error_message TEXT",
      "ALTER TABLE session_snapshots ADD COLUMN usage_count INTEGER NOT NULL DEFAULT 0 CHECK (usage_count >= 0)",
      "CREATE INDEX IF NOT EXISTS session_snapshots_project_status_idx ON session_snapshots (project_id, status, expires_at)",
      "CREATE INDEX IF NOT EXISTS session_snapshots_provider_snapshot_idx ON session_snapshots (provider, provider_snapshot_id)",
    ],
  },
  {
    id: PACKAGE_REGISTRY_AUDIT_SCHEMA_MIGRATION_ID,
    description: "Add package registry authorization audit schema",
    sql: [
      `CREATE TABLE IF NOT EXISTS package_registry_audits (
        id TEXT PRIMARY KEY NOT NULL,
        project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE ON UPDATE CASCADE,
        task_id TEXT NOT NULL,
        session_id TEXT NOT NULL,
        ecosystem TEXT NOT NULL,
        registry_host TEXT NOT NULL,
        package_name TEXT NOT NULL,
        requested_version TEXT,
        resolved_version TEXT,
        decision TEXT NOT NULL CHECK (decision IN ('allowed', 'denied', 'failed')),
        reason TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
        FOREIGN KEY (project_id, task_id) REFERENCES tasks(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE,
        FOREIGN KEY (project_id, session_id) REFERENCES sessions(project_id, id) ON DELETE CASCADE ON UPDATE CASCADE
      )`,
      "CREATE INDEX IF NOT EXISTS package_registry_audits_session_idx ON package_registry_audits (project_id, session_id, created_at)",
      "CREATE INDEX IF NOT EXISTS package_registry_audits_package_idx ON package_registry_audits (project_id, registry_host, package_name)",
      "CREATE INDEX IF NOT EXISTS package_registry_audits_decision_idx ON package_registry_audits (project_id, decision, created_at)",
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
