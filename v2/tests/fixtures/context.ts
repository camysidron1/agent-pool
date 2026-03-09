import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createDatabase } from '../../src/stores/sqlite/connection.js';
import { applyMigrations } from '../../src/stores/sqlite/schema.js';
import { SqliteProjectStore } from '../../src/stores/sqlite/project-store.js';
import { SqliteCloneStore } from '../../src/stores/sqlite/clone-store.js';
import { SqliteTaskStore } from '../../src/stores/sqlite/task-store.js';
import { MockCmuxClient } from '../../src/cmux/mock.js';
import { MockGitClient } from '../../src/git/mock.js';
import type { AppContext } from '../../src/container.js';

export interface TestContext extends AppContext {
  cleanup: () => void;
}

export function createTestContext(): TestContext {
  const tmpDir = mkdtempSync(join(tmpdir(), 'ap-test-'));
  const db = createDatabase(join(tmpDir, 'test.db'));
  applyMigrations(db);

  const stores = {
    projects: new SqliteProjectStore(db),
    clones: new SqliteCloneStore(db),
    tasks: new SqliteTaskStore(db),
  };

  const cmux = new MockCmuxClient();
  const git = new MockGitClient();

  return {
    db,
    stores,
    cmux,
    git,
    config: { dataDir: tmpDir, toolDir: tmpDir },
    cleanup: () => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}
