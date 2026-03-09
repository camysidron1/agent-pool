import { Database } from 'bun:sqlite';
import type { Clone, CloneStore } from '../interfaces.js';

interface CloneRow {
  id: number;
  project_name: string;
  clone_index: number;
  locked: number;
  workspace_id: string;
  locked_at: string | null;
  branch: string;
}

function rowToClone(row: CloneRow): Clone {
  return {
    id: row.id,
    projectName: row.project_name,
    cloneIndex: row.clone_index,
    locked: row.locked === 1,
    workspaceId: row.workspace_id,
    lockedAt: row.locked_at,
    branch: row.branch,
  };
}

export class SqliteCloneStore implements CloneStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  add(projectName: string, index: number, branch: string): void {
    this.db.query(
      `INSERT INTO clones (project_name, clone_index, branch) VALUES (?, ?, ?)`
    ).run(projectName, index, branch);
  }

  getAll(projectName: string): Clone[] {
    const rows = this.db.query(
      'SELECT * FROM clones WHERE project_name = ? ORDER BY clone_index'
    ).all(projectName) as CloneRow[];
    return rows.map(rowToClone);
  }

  get(projectName: string, index: number): Clone | null {
    const row = this.db.query(
      'SELECT * FROM clones WHERE project_name = ? AND clone_index = ?'
    ).get(projectName, index) as CloneRow | null;
    return row ? rowToClone(row) : null;
  }

  lock(projectName: string, index: number, workspaceId: string): void {
    this.db.query(
      `UPDATE clones SET locked = 1, workspace_id = ?, locked_at = ?
       WHERE project_name = ? AND clone_index = ?`
    ).run(workspaceId, new Date().toISOString(), projectName, index);
  }

  unlock(projectName: string, index: number): void {
    this.db.query(
      `UPDATE clones SET locked = 0, workspace_id = '', locked_at = NULL
       WHERE project_name = ? AND clone_index = ?`
    ).run(projectName, index);
  }

  findFree(projectName: string): Clone | null {
    const row = this.db.query(
      `SELECT * FROM clones WHERE project_name = ? AND locked = 0 ORDER BY clone_index LIMIT 1`
    ).get(projectName) as CloneRow | null;
    return row ? rowToClone(row) : null;
  }

  nextIndex(projectName: string): number {
    const row = this.db.query(
      'SELECT MAX(clone_index) as max_idx FROM clones WHERE project_name = ?'
    ).get(projectName) as { max_idx: number | null };
    return row.max_idx === null ? 0 : row.max_idx + 1;
  }

  remove(projectName: string, index: number): void {
    this.db.query(
      'DELETE FROM clones WHERE project_name = ? AND clone_index = ?'
    ).run(projectName, index);
  }
}
