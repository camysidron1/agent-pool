import { Database } from 'bun:sqlite';
import type { Task, TaskInput, TaskLog, TaskStatus, TaskStore } from '../interfaces.js';

interface TaskRow {
  id: string;
  project_name: string;
  prompt: string;
  status: TaskStatus;
  claimed_by: string | null;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  priority: number;
  timeout_minutes: number | null;
  retry_max: number;
  retry_count: number;
  retry_strategy: 'same' | 'augmented' | 'escalate';
  result: string | null;
}

interface TaskLogRow {
  id: number;
  task_id: string;
  agent_id: string;
  log_path: string;
  started_at: string;
  completed_at: string | null;
  exit_code: number | null;
  created_at: string;
}

function rowToTask(row: TaskRow): Task {
  return {
    id: row.id,
    projectName: row.project_name,
    prompt: row.prompt,
    status: row.status,
    claimedBy: row.claimed_by,
    createdAt: row.created_at,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    priority: row.priority,
    timeoutMinutes: row.timeout_minutes,
    retryMax: row.retry_max,
    retryCount: row.retry_count,
    retryStrategy: row.retry_strategy,
    result: row.result,
  };
}

function rowToTaskLog(row: TaskLogRow): TaskLog {
  return {
    id: row.id,
    taskId: row.task_id,
    agentId: row.agent_id,
    logPath: row.log_path,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    exitCode: row.exit_code,
    createdAt: row.created_at,
  };
}

let idCounter = 0;

export class SqliteTaskStore implements TaskStore {
  private db: Database;

  constructor(db: Database) {
    this.db = db;
  }

  add(input: TaskInput): Task {
    const id = `t-${Date.now()}-${idCounter++}`;
    const now = new Date().toISOString();
    const status = input.status ?? 'pending';
    const priority = input.priority ?? 0;
    const timeoutMinutes = input.timeoutMinutes ?? null;
    const retryMax = input.retryMax ?? 1;
    const retryStrategy = input.retryStrategy ?? 'same';

    this.db.transaction(() => {
      this.db.query(
        `INSERT INTO tasks (id, project_name, prompt, status, created_at, priority, timeout_minutes, retry_max, retry_strategy)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, input.projectName, input.prompt, status, now, priority, timeoutMinutes, retryMax, retryStrategy);

      if (input.dependsOn && input.dependsOn.length > 0) {
        for (const depId of input.dependsOn) {
          // Validate dependency exists
          const dep = this.db.query('SELECT id FROM tasks WHERE id = ?').get(depId);
          if (!dep) {
            throw new Error(`Dependency task ${depId} does not exist`);
          }
          this.db.query(
            'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)'
          ).run(id, depId);
        }
      }
    })();

    return this.get(id)!;
  }

  getAll(projectName: string): Task[] {
    const rows = this.db.query(
      'SELECT * FROM tasks WHERE project_name = ? ORDER BY created_at'
    ).all(projectName) as TaskRow[];
    return rows.map(rowToTask);
  }

  get(id: string): Task | null {
    const row = this.db.query('SELECT * FROM tasks WHERE id = ?').get(id) as TaskRow | null;
    return row ? rowToTask(row) : null;
  }

  claim(projectName: string, agentId: string): Task | null {
    let claimed: Task | null = null;

    this.db.transaction(() => {
      // Find first pending task where all dependencies are completed (or has no deps)
      // Priority DESC, then created_at ASC
      const row = this.db.query(`
        SELECT t.* FROM tasks t
        WHERE t.project_name = ? AND t.status = 'pending'
          AND NOT EXISTS (
            SELECT 1 FROM task_dependencies td
            JOIN tasks dep ON dep.id = td.depends_on
            WHERE td.task_id = t.id AND dep.status != 'completed'
          )
        ORDER BY t.priority DESC, t.created_at ASC
        LIMIT 1
      `).get(projectName) as TaskRow | null;

      if (!row) return;

      const now = new Date().toISOString();
      this.db.query(
        `UPDATE tasks SET status = 'in_progress', claimed_by = ?, started_at = ? WHERE id = ?`
      ).run(agentId, now, row.id);

      claimed = rowToTask({
        ...row,
        status: 'in_progress',
        claimed_by: agentId,
        started_at: now,
      });
    })();

    return claimed;
  }

  nextEligible(projectName: string, limit: number = 1): Task[] {
    const rows = this.db.query(`
      SELECT t.* FROM tasks t
      WHERE t.project_name = ? AND t.status = 'pending'
        AND NOT EXISTS (
          SELECT 1 FROM task_dependencies td
          JOIN tasks dep ON dep.id = td.depends_on
          WHERE td.task_id = t.id AND dep.status != 'completed'
        )
      ORDER BY t.priority DESC, t.created_at ASC
      LIMIT ?
    `).all(projectName, limit) as TaskRow[];
    return rows.map(rowToTask);
  }

  mark(id: string, status: TaskStatus, fields?: Partial<Task>): void {
    const sets: string[] = ['status = ?'];
    const values: unknown[] = [status];

    // Set completed_at for terminal/blocked/cancelled statuses
    if (status === 'completed' || status === 'blocked' || status === 'cancelled') {
      sets.push('completed_at = ?');
      values.push(new Date().toISOString());
    }

    if (fields) {
      const columnMap: Record<string, string> = {
        claimedBy: 'claimed_by',
        startedAt: 'started_at',
        completedAt: 'completed_at',
        prompt: 'prompt',
        projectName: 'project_name',
        priority: 'priority',
        timeoutMinutes: 'timeout_minutes',
        retryMax: 'retry_max',
        retryCount: 'retry_count',
        retryStrategy: 'retry_strategy',
        result: 'result',
      };

      for (const [key, value] of Object.entries(fields)) {
        if (key === 'id' || key === 'status') continue;
        const col = columnMap[key];
        if (!col) continue;
        // Don't duplicate completed_at if we already set it
        if (col === 'completed_at' && (status === 'completed' || status === 'blocked' || status === 'cancelled')) continue;
        sets.push(`${col} = ?`);
        values.push(value);
      }
    }

    values.push(id);
    this.db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  updateFields(id: string, fields: Partial<Pick<Task, 'priority' | 'timeoutMinutes' | 'retryMax' | 'retryStrategy' | 'result' | 'prompt' | 'retryCount'>>): void {
    const columnMap: Record<string, string> = {
      priority: 'priority',
      timeoutMinutes: 'timeout_minutes',
      retryMax: 'retry_max',
      retryCount: 'retry_count',
      retryStrategy: 'retry_strategy',
      result: 'result',
      prompt: 'prompt',
    };

    const sets: string[] = [];
    const values: unknown[] = [];

    for (const [key, value] of Object.entries(fields)) {
      const col = columnMap[key];
      if (!col) continue;
      sets.push(`${col} = ?`);
      values.push(value);
    }

    if (sets.length === 0) return;

    values.push(id);
    this.db.query(`UPDATE tasks SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  }

  getDependencies(taskId: string): string[] {
    const rows = this.db.query(
      'SELECT depends_on FROM task_dependencies WHERE task_id = ?'
    ).all(taskId) as { depends_on: string }[];
    return rows.map(r => r.depends_on);
  }

  addDependency(taskId: string, dependsOn: string): void {
    this.db.query(
      'INSERT INTO task_dependencies (task_id, depends_on) VALUES (?, ?)'
    ).run(taskId, dependsOn);
  }

  addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog {
    const now = new Date().toISOString();
    this.db.query(
      `INSERT INTO task_logs (task_id, agent_id, log_path, started_at, completed_at, exit_code, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(log.taskId, log.agentId, log.logPath, log.startedAt, log.completedAt, log.exitCode, now);

    const row = this.db.query(
      'SELECT * FROM task_logs WHERE rowid = last_insert_rowid()'
    ).get() as TaskLogRow;
    return rowToTaskLog(row);
  }

  getLogs(filter: { taskId?: string; agentId?: string; limit?: number }): TaskLog[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filter.taskId) {
      conditions.push('task_id = ?');
      values.push(filter.taskId);
    }
    if (filter.agentId) {
      conditions.push('agent_id = ?');
      values.push(filter.agentId);
    }

    const where = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
    const limit = filter.limit ? `LIMIT ${filter.limit}` : '';

    const rows = this.db.query(
      `SELECT * FROM task_logs ${where} ORDER BY created_at DESC ${limit}`
    ).all(...values) as TaskLogRow[];
    return rows.map(rowToTaskLog);
  }
}
