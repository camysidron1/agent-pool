import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { Database } from 'bun:sqlite';
import { createDatabase } from '../../../src/stores/sqlite/connection.js';
import { applyMigrations } from '../../../src/stores/sqlite/schema.js';
import { migrateFromV1 } from '../../../src/stores/migrate-v1.js';
import {
  createV1Fixtures,
  createMinimalV1Fixtures,
  createEdgeCaseV1Fixtures,
} from '../../fixtures/v1-data.js';

function setupDb(): { db: Database; tmpDir: string; dataDir: string; cleanup: () => void } {
  const tmpDir = mkdtempSync(join(tmpdir(), 'migrate-v1-test-'));
  const db = createDatabase(join(tmpDir, 'test.db'));
  applyMigrations(db);
  const dataDir = join(tmpDir, 'v1-data');
  return {
    db,
    tmpDir,
    dataDir,
    cleanup: () => {
      db.close();
      rmSync(tmpDir, { recursive: true, force: true });
    },
  };
}

describe('migrateFromV1', () => {
  let db: Database;
  let tmpDir: string;
  let dataDir: string;
  let cleanup: () => void;

  beforeEach(() => {
    ({ db, tmpDir, dataDir, cleanup } = setupDb());
  });

  afterEach(() => {
    cleanup();
  });

  test('basic migration: 1 project with tasks and clones', () => {
    createV1Fixtures(dataDir);

    const result = migrateFromV1(db, dataDir);

    expect(result.projects).toBe(1);
    expect(result.clones).toBe(2);
    expect(result.tasks).toBe(2);
    expect(result.errors).toEqual([]);

    // Verify project row
    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('myproject') as any;
    expect(proj).not.toBeNull();
    expect(proj.source).toBe('/path/to/myproject');
    expect(proj.prefix).toBe('my');
    expect(proj.branch).toBe('main');
    expect(proj.setup).toBe('bun install');
    expect(proj.is_default).toBe(1);

    // Verify clones
    const clones = db.query('SELECT * FROM clones WHERE project_name = ? ORDER BY clone_index').all('myproject') as any[];
    expect(clones.length).toBe(2);
    expect(clones[0].locked).toBe(1);
    expect(clones[0].workspace_id).toBe('workspace:0');
    expect(clones[1].locked).toBe(0);

    // Verify tasks
    const tasks = db.query('SELECT * FROM tasks WHERE project_name = ? ORDER BY id').all('myproject') as any[];
    expect(tasks.length).toBe(2);
    expect(tasks[0].status).toBe('completed');
    expect(tasks[0].claimed_by).toBe('agent-01');
    expect(tasks[1].status).toBe('pending');
    expect(tasks[1].claimed_by).toBeNull();
  });

  test('multi-project migration', () => {
    createV1Fixtures(dataDir, { projectCount: 3, tasksPerProject: 1, clonesPerProject: 1 });

    const result = migrateFromV1(db, dataDir);

    expect(result.projects).toBe(3);
    expect(result.clones).toBe(3);
    expect(result.tasks).toBe(3);
    expect(result.errors).toEqual([]);

    // Only first project is default
    const allProjects = db.query('SELECT * FROM projects ORDER BY name').all() as any[];
    expect(allProjects.length).toBe(3);
    const defaults = allProjects.filter((p: any) => p.is_default === 1);
    expect(defaults.length).toBe(1);
    expect(defaults[0].name).toBe('myproject');
  });

  test('migration with dependencies', () => {
    createV1Fixtures(dataDir, { tasksPerProject: 3, includeDependencies: true });

    const result = migrateFromV1(db, dataDir);

    expect(result.tasks).toBe(3);
    // Task 1 depends on task 0, task 2 depends on task 1
    expect(result.dependencies).toBe(2);
    expect(result.errors).toEqual([]);

    const deps = db.query('SELECT * FROM task_dependencies ORDER BY task_id').all() as any[];
    expect(deps.length).toBe(2);
    expect(deps[0].task_id).toBe('t-myproject-1');
    expect(deps[0].depends_on).toBe('t-myproject-0');
    expect(deps[1].task_id).toBe('t-myproject-2');
    expect(deps[1].depends_on).toBe('t-myproject-1');
  });

  test('migration with tracking config', () => {
    createV1Fixtures(dataDir, { includeTracking: true });

    const result = migrateFromV1(db, dataDir);

    expect(result.errors).toEqual([]);
    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('myproject') as any;
    expect(proj.tracking_type).toBe('linear');
    expect(proj.tracking_project_key).toBe('MYP');
    expect(proj.tracking_label).toBe('bug');
    expect(proj.tracking_instructions).toBe('Link to issue');
  });

  test('migration with workflow config', () => {
    createV1Fixtures(dataDir, { includeWorkflow: true });

    const result = migrateFromV1(db, dataDir);

    expect(result.errors).toEqual([]);
    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('myproject') as any;
    expect(proj.workflow_type).toBe('pr');
    expect(proj.workflow_instructions).toBe('Use conventional commits');
    expect(proj.workflow_auto_merge).toBe(1);
    expect(proj.workflow_merge_method).toBe('squash');
  });

  test('missing projects.json returns error', () => {
    // dataDir exists but has no files
    const emptyDir = join(tmpDir, 'empty');
    const result = migrateFromV1(db, emptyDir);

    expect(result.projects).toBe(0);
    expect(result.errors.length).toBe(1);
    expect(result.errors[0]).toContain('projects.json');
  });

  test('missing pool/tasks files gracefully skips', () => {
    createMinimalV1Fixtures(dataDir);

    const result = migrateFromV1(db, dataDir);

    expect(result.projects).toBe(1);
    expect(result.clones).toBe(0);
    expect(result.tasks).toBe(0);
    expect(result.errors).toEqual([]);

    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('minimal') as any;
    expect(proj).not.toBeNull();
    expect(proj.is_default).toBe(1);
  });

  test('empty task and clone arrays work fine', () => {
    createEdgeCaseV1Fixtures(dataDir);

    const result = migrateFromV1(db, dataDir);

    expect(result.projects).toBe(2);
    expect(result.clones).toBe(0);
    expect(result.tasks).toBe(0);
    expect(result.errors).toEqual([]);
  });

  test('null/missing optional fields use defaults', () => {
    createEdgeCaseV1Fixtures(dataDir);

    const result = migrateFromV1(db, dataDir);

    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('edgecase') as any;
    expect(proj.tracking_type).toBeNull();
    expect(proj.tracking_project_key).toBeNull();
    expect(proj.workflow_type).toBeNull();
    expect(proj.workflow_auto_merge).toBeNull();
    expect(proj.setup).toBeNull();
  });

  test('idempotency: running twice reports duplicates', () => {
    createV1Fixtures(dataDir);

    const first = migrateFromV1(db, dataDir);
    expect(first.projects).toBe(1);
    expect(first.errors).toEqual([]);

    const second = migrateFromV1(db, dataDir);
    expect(second.projects).toBe(0);
    expect(second.errors.length).toBeGreaterThan(0);
    expect(second.errors.some(e => e.includes('Duplicate project'))).toBe(true);

    // DB still has exactly 1 project, not 2
    const count = db.query('SELECT COUNT(*) as c FROM projects').get() as any;
    expect(count.c).toBe(1);
  });

  test('task with unknown dependency reports error but still migrates task', () => {
    createV1Fixtures(dataDir, { tasksPerProject: 1 });

    // Manually write a tasks file with an unknown dependency
    const tasksJson = {
      tasks: [
        {
          id: 't-manual-1',
          prompt: 'Do something',
          status: 'pending',
          claimed_by: null,
          created_at: '2025-01-15T10:00:00',
          started_at: null,
          completed_at: null,
          depends_on: ['t-nonexistent'],
        },
      ],
    };
    writeFileSync(join(dataDir, 'tasks-myproject.json'), JSON.stringify(tasksJson));

    const result = migrateFromV1(db, dataDir);

    expect(result.tasks).toBe(1);
    expect(result.dependencies).toBe(0);
    expect(result.errors.some(e => e.includes('unknown task'))).toBe(true);
  });

  test('tracking and workflow both present together', () => {
    createV1Fixtures(dataDir, { includeTracking: true, includeWorkflow: true });

    const result = migrateFromV1(db, dataDir);

    expect(result.errors).toEqual([]);
    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('myproject') as any;
    expect(proj.tracking_type).toBe('linear');
    expect(proj.workflow_type).toBe('pr');
    expect(proj.workflow_auto_merge).toBe(1);
  });

  test('project without default field set', () => {
    mkdirSync(dataDir, { recursive: true });
    const noDefaultData = {
      projects: {
        solo: {
          source: '/src/solo',
          prefix: 'sl',
          branch: 'main',
        },
      },
    };
    writeFileSync(join(dataDir, 'projects.json'), JSON.stringify(noDefaultData));

    const result = migrateFromV1(db, dataDir);

    expect(result.projects).toBe(1);
    expect(result.errors).toEqual([]);
    const proj = db.query('SELECT * FROM projects WHERE name = ?').get('solo') as any;
    expect(proj.is_default).toBe(0);
  });
});
