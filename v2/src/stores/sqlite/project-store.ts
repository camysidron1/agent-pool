import { Database } from 'bun:sqlite';
import type { Project, ProjectInput, ProjectStore } from '../interfaces.js';

interface ProjectRow {
  name: string;
  source: string;
  prefix: string;
  branch: string;
  setup: string | null;
  is_default: number;
  tracking_type: string | null;
  tracking_project_key: string | null;
  tracking_label: string | null;
  tracking_instructions: string | null;
  workflow_type: string | null;
  workflow_instructions: string | null;
  workflow_auto_merge: number | null;
  workflow_merge_method: string | null;
}

function rowToProject(row: ProjectRow): Project {
  return {
    name: row.name,
    source: row.source,
    prefix: row.prefix,
    branch: row.branch,
    setup: row.setup,
    isDefault: row.is_default === 1,
    trackingType: row.tracking_type,
    trackingProjectKey: row.tracking_project_key,
    trackingLabel: row.tracking_label,
    trackingInstructions: row.tracking_instructions,
    workflowType: row.workflow_type,
    workflowInstructions: row.workflow_instructions,
    workflowAutoMerge: row.workflow_auto_merge === null ? null : row.workflow_auto_merge === 1,
    workflowMergeMethod: row.workflow_merge_method,
  };
}

export class SqliteProjectStore implements ProjectStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  getAll(): Project[] {
    const rows = this.db.query('SELECT * FROM projects').all() as ProjectRow[];
    return rows.map(rowToProject);
  }

  get(name: string): Project | null {
    const row = this.db.query('SELECT * FROM projects WHERE name = ?').get(name) as ProjectRow | null;
    return row ? rowToProject(row) : null;
  }

  getDefault(): Project | null {
    const row = this.db.query('SELECT * FROM projects WHERE is_default = 1').get() as ProjectRow | null;
    return row ? rowToProject(row) : null;
  }

  add(project: ProjectInput): void {
    const prefix = project.prefix ?? project.name;
    const branch = project.branch ?? 'main';
    const setup = project.setup ?? null;

    // Check if this is the first project
    const count = this.db.query('SELECT COUNT(*) as cnt FROM projects').get() as { cnt: number };
    const isDefault = count.cnt === 0 ? 1 : 0;

    this.db.query(
      `INSERT INTO projects (name, source, prefix, branch, setup, is_default)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(name(project), project.source, prefix, branch, setup, isDefault);
  }

  remove(name: string): void {
    this.db.query('DELETE FROM projects WHERE name = ?').run(name);
  }

  setDefault(name: string): void {
    this.db.transaction(() => {
      this.db.query('UPDATE projects SET is_default = 0').run();
      this.db.query('UPDATE projects SET is_default = 1 WHERE name = ?').run(name);
    })();
  }

  update(name: string, fields: Partial<Project>): void {
    const columnMap: Record<string, string> = {
      source: 'source',
      prefix: 'prefix',
      branch: 'branch',
      setup: 'setup',
      isDefault: 'is_default',
      trackingType: 'tracking_type',
      trackingProjectKey: 'tracking_project_key',
      trackingLabel: 'tracking_label',
      trackingInstructions: 'tracking_instructions',
      workflowType: 'workflow_type',
      workflowInstructions: 'workflow_instructions',
      workflowAutoMerge: 'workflow_auto_merge',
      workflowMergeMethod: 'workflow_merge_method',
    };

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      const col = columnMap[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      if (key === 'isDefault') {
        values.push(value ? 1 : 0);
      } else if (key === 'workflowAutoMerge') {
        values.push(value === null ? null : value ? 1 : 0);
      } else {
        values.push(value);
      }
    }

    if (sets.length === 0) return;

    values.push(name);
    this.db.query(`UPDATE projects SET ${sets.join(', ')} WHERE name = ?`).run(...values);
  }
}

function name(project: ProjectInput): string {
  return project.name;
}
