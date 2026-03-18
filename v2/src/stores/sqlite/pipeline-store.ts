import { Database } from 'bun:sqlite';
import type { Pipeline, PipelineStatus, PipelineStore, TaskStatus } from '../interfaces.js';

interface PipelineRow {
  id: string;
  project_name: string;
  name: string;
  params: string | null;
  status: PipelineStatus;
  created_at: string;
  completed_at: string | null;
}

function rowToPipeline(row: PipelineRow): Pipeline {
  return {
    id: row.id,
    projectName: row.project_name,
    name: row.name,
    params: row.params ? JSON.parse(row.params) : null,
    status: row.status,
    createdAt: row.created_at,
    completedAt: row.completed_at,
  };
}

export class SqlitePipelineStore implements PipelineStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  get(id: string): Pipeline | null {
    const row = this.db.query('SELECT * FROM pipelines WHERE id = ?').get(id) as PipelineRow | null;
    return row ? rowToPipeline(row) : null;
  }

  getAll(projectName: string): Pipeline[] {
    const rows = this.db.query(
      'SELECT * FROM pipelines WHERE project_name = ? ORDER BY created_at'
    ).all(projectName) as PipelineRow[];
    return rows.map(rowToPipeline);
  }

  create(pipeline: Omit<Pipeline, 'completedAt'>): Pipeline {
    const params = pipeline.params ? JSON.stringify(pipeline.params) : null;
    this.db.query(
      `INSERT INTO pipelines (id, project_name, name, params, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(pipeline.id, pipeline.projectName, pipeline.name, params, pipeline.status, pipeline.createdAt);

    return this.get(pipeline.id)!;
  }

  updateStatus(id: string, status: PipelineStatus): void {
    const completedAt = (status === 'completed' || status === 'failed' || status === 'cancelled')
      ? new Date().toISOString()
      : null;
    this.db.query(
      'UPDATE pipelines SET status = ?, completed_at = ? WHERE id = ?'
    ).run(status, completedAt, id);
  }

  refreshStatus(id: string): PipelineStatus {
    const rows = this.db.query(
      'SELECT status FROM tasks WHERE pipeline_id = ?'
    ).all(id) as { status: TaskStatus }[];

    let status: PipelineStatus;

    if (rows.length === 0) {
      status = 'pending';
    } else {
      const statuses = rows.map(r => r.status);
      const hasInProgress = statuses.includes('in_progress');
      const hasPending = statuses.includes('pending');
      const hasCancelled = statuses.includes('cancelled');
      const hasBlocked = statuses.includes('blocked');
      const hasCompleted = statuses.includes('completed');
      const allCompleted = statuses.every(s => s === 'completed');

      if (allCompleted) {
        status = 'completed';
      } else if (hasCancelled && !hasInProgress) {
        status = 'cancelled';
      } else if (hasBlocked && !hasInProgress && !hasPending) {
        status = 'failed';
      } else if (hasInProgress || (hasPending && hasCompleted)) {
        status = 'in_progress';
      } else {
        status = 'pending';
      }
    }

    this.updateStatus(id, status);
    return status;
  }

  getByProject(projectName: string): Pipeline[] {
    return this.getAll(projectName);
  }
}
