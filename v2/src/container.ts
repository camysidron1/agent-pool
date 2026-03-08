import { Database } from 'bun:sqlite';
import { mkdirSync } from 'fs';
import { join } from 'path';
import type { ProjectStore, CloneStore, TaskStore } from './stores/interfaces.js';
import type { CmuxClient } from './cmux/interfaces.js';
import type { GitClient } from './git/interfaces.js';
import { SqliteProjectStore } from './stores/sqlite/project-store.js';
import { SqliteCloneStore } from './stores/sqlite/clone-store.js';
import { SqliteTaskStore } from './stores/sqlite/task-store.js';
import { RealCmuxClient } from './cmux/cmux.js';
import { RealGitClient } from './git/git.js';
import { createDatabase } from './stores/sqlite/connection.js';
import { applyMigrations } from './stores/sqlite/schema.js';

export interface AppContext {
  db: Database;
  stores: {
    projects: ProjectStore;
    clones: CloneStore;
    tasks: TaskStore;
  };
  cmux: CmuxClient;
  git: GitClient;
  config: {
    dataDir: string;
    toolDir: string;
  };
}

export function createProductionContext(opts: { dataDir: string; toolDir: string }): AppContext {
  mkdirSync(opts.dataDir, { recursive: true });
  const db = createDatabase(join(opts.dataDir, 'agent-pool.db'));
  applyMigrations(db);

  const stores = {
    projects: new SqliteProjectStore(db),
    clones: new SqliteCloneStore(db),
    tasks: new SqliteTaskStore(db),
  };

  const cmux = new RealCmuxClient();
  const git = new RealGitClient();

  return {
    db,
    stores,
    cmux,
    git,
    config: { dataDir: opts.dataDir, toolDir: opts.toolDir },
  };
}
