import { Database } from 'bun:sqlite';

const MIGRATIONS: string[] = [
  // v1: initial schema
  `
  CREATE TABLE IF NOT EXISTS projects (
    name TEXT PRIMARY KEY,
    source TEXT NOT NULL,
    prefix TEXT NOT NULL,
    branch TEXT NOT NULL DEFAULT 'main',
    setup TEXT,
    is_default INTEGER DEFAULT 0,
    tracking_type TEXT,
    tracking_project_key TEXT,
    tracking_label TEXT,
    tracking_instructions TEXT,
    workflow_type TEXT,
    workflow_instructions TEXT,
    workflow_auto_merge INTEGER,
    workflow_merge_method TEXT
  );

  CREATE TABLE IF NOT EXISTS clones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
    clone_index INTEGER NOT NULL,
    locked INTEGER DEFAULT 0,
    workspace_id TEXT DEFAULT '',
    locked_at TEXT,
    branch TEXT NOT NULL,
    UNIQUE(project_name, clone_index)
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','in_progress','completed','blocked','backlogged')),
    claimed_by TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS task_dependencies (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_name, status);
  CREATE INDEX IF NOT EXISTS idx_clones_project ON clones(project_name);
  `,

  // v2: Phase 2 — new task fields, cancelled status, task_logs
  `
  -- Add new columns
  ALTER TABLE tasks ADD COLUMN priority INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN timeout_minutes INTEGER;
  ALTER TABLE tasks ADD COLUMN retry_max INTEGER NOT NULL DEFAULT 1;
  ALTER TABLE tasks ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN retry_strategy TEXT NOT NULL DEFAULT 'same'
    CHECK(retry_strategy IN ('same','augmented','escalate'));
  ALTER TABLE tasks ADD COLUMN result TEXT;
  `,

  // v3: Recreate tasks table to add 'cancelled' to status CHECK + task_logs
  `
  CREATE TABLE tasks_new (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
    prompt TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','in_progress','completed','blocked','backlogged','cancelled')),
    claimed_by TEXT,
    created_at TEXT NOT NULL,
    started_at TEXT,
    completed_at TEXT,
    priority INTEGER NOT NULL DEFAULT 0,
    timeout_minutes INTEGER,
    retry_max INTEGER NOT NULL DEFAULT 1,
    retry_count INTEGER NOT NULL DEFAULT 0,
    retry_strategy TEXT NOT NULL DEFAULT 'same'
      CHECK(retry_strategy IN ('same','augmented','escalate')),
    result TEXT
  );
  INSERT INTO tasks_new SELECT * FROM tasks;
  DROP TABLE tasks;
  ALTER TABLE tasks_new RENAME TO tasks;

  -- Recreate indexes
  CREATE INDEX idx_tasks_project_status ON tasks(project_name, status);
  CREATE INDEX idx_tasks_priority ON tasks(project_name, status, priority DESC);

  -- Recreate task_dependencies (FKs reference the new tasks table)
  CREATE TABLE IF NOT EXISTS task_dependencies_new (
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    depends_on TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    PRIMARY KEY (task_id, depends_on)
  );
  INSERT OR IGNORE INTO task_dependencies_new SELECT * FROM task_dependencies;
  DROP TABLE task_dependencies;
  ALTER TABLE task_dependencies_new RENAME TO task_dependencies;

  -- Task logs table
  CREATE TABLE IF NOT EXISTS task_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id TEXT NOT NULL,
    agent_id TEXT NOT NULL,
    log_path TEXT NOT NULL,
    started_at TEXT NOT NULL,
    completed_at TEXT,
    exit_code INTEGER,
    created_at TEXT NOT NULL
  );
  CREATE INDEX idx_task_logs_task ON task_logs(task_id);
  CREATE INDEX idx_task_logs_agent ON task_logs(agent_id);
  `,
  // v4: Add agent_type to projects
  `
  ALTER TABLE projects ADD COLUMN agent_type TEXT;
  `,

  // v5: Pipelines table + pipeline columns on tasks
  `
  CREATE TABLE pipelines (
    id TEXT PRIMARY KEY,
    project_name TEXT NOT NULL REFERENCES projects(name) ON DELETE CASCADE,
    name TEXT NOT NULL,
    params TEXT,
    status TEXT NOT NULL DEFAULT 'pending'
      CHECK(status IN ('pending','in_progress','completed','failed','cancelled')),
    created_at TEXT NOT NULL,
    completed_at TEXT
  );
  CREATE INDEX idx_pipelines_project ON pipelines(project_name);

  ALTER TABLE tasks ADD COLUMN pipeline_id TEXT REFERENCES pipelines(id) ON DELETE SET NULL;
  ALTER TABLE tasks ADD COLUMN pipeline_step_id TEXT;
  CREATE INDEX idx_tasks_pipeline ON tasks(pipeline_id);
  `,

  // v6: Per-project environment variables
  `
  ALTER TABLE projects ADD COLUMN env_vars TEXT;
  `,

  // v7: Workspace isolation — scope clones and tasks by workspace
  `
  ALTER TABLE clones ADD COLUMN workspace_ref TEXT DEFAULT '';
  ALTER TABLE tasks ADD COLUMN workspace_ref TEXT DEFAULT '';
  CREATE INDEX idx_clones_workspace ON clones(project_name, workspace_ref);
  CREATE INDEX idx_tasks_workspace ON tasks(project_name, workspace_ref, status);
  `,

  // v8: Task-level branch override for continuing work on existing branches
  `
  ALTER TABLE tasks ADD COLUMN branch TEXT;
  `,
];

/**
 * Apply all pending migrations. Idempotent — safe to call on every startup.
 */
export function applyMigrations(db: Database): void {
  db.run('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY)');

  const row = db.query('SELECT MAX(version) as v FROM schema_version').get() as { v: number | null } | null;
  const currentVersion = row?.v ?? 0;

  for (let i = currentVersion; i < MIGRATIONS.length; i++) {
    db.exec(MIGRATIONS[i]);
    db.exec(`INSERT INTO schema_version (version) VALUES (${i + 1})`);
  }
}
