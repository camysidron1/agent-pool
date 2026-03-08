import type { TaskStore, TaskInput, Task, TaskLog, TaskStatus } from '../stores/interfaces.js';

export class TaskService {
  constructor(private store: TaskStore) {}

  add(input: TaskInput): Task {
    return this.store.add(input);
  }

  list(projectName: string): Task[] {
    return this.store.getAll(projectName);
  }

  get(id: string): Task | null {
    return this.store.get(id);
  }

  claim(projectName: string, agentId: string): Task | null {
    return this.store.claim(projectName, agentId);
  }

  mark(id: string, status: TaskStatus): void {
    this.store.mark(id, status);
  }

  updateFields(id: string, fields: Partial<Pick<Task, 'priority' | 'timeoutMinutes' | 'retryMax' | 'retryStrategy' | 'result' | 'prompt' | 'retryCount'>>): void {
    this.store.updateFields(id, fields);
  }

  unblock(id: string): void {
    const task = this.store.get(id);
    if (!task) {
      throw new Error(`Task '${id}' not found`);
    }
    if (task.status !== 'blocked') {
      throw new Error(`Task '${id}' is not blocked (status: ${task.status})`);
    }
    this.store.mark(id, 'pending', { claimedBy: null, startedAt: null, completedAt: null });
  }

  backlog(id: string): void {
    const task = this.store.get(id);
    if (!task) {
      throw new Error(`Task '${id}' not found`);
    }
    if (task.status !== 'backlogged' && task.status !== 'pending') {
      throw new Error(`Task '${id}' must be backlogged or pending to backlog (status: ${task.status})`);
    }
    this.store.mark(id, 'backlogged', { claimedBy: null });
  }

  activate(id: string): void {
    const task = this.store.get(id);
    if (!task) {
      throw new Error(`Task '${id}' not found`);
    }
    if (task.status !== 'backlogged') {
      throw new Error(`Task '${id}' is not backlogged (status: ${task.status})`);
    }
    this.store.mark(id, 'pending');
  }

  setStatus(id: string, status: TaskStatus): void {
    const task = this.store.get(id);
    if (!task) {
      throw new Error(`Task '${id}' not found`);
    }
    if (status === 'pending' || status === 'backlogged') {
      this.store.mark(id, status, { claimedBy: null, startedAt: null, completedAt: null });
    } else if (status === 'completed' || status === 'blocked' || status === 'cancelled') {
      this.store.mark(id, status, { completedAt: new Date().toISOString() });
    } else {
      this.store.mark(id, status);
    }
  }

  getDependencies(taskId: string): string[] {
    return this.store.getDependencies(taskId);
  }

  addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog {
    return this.store.addLog(log);
  }

  getLogs(filter: { taskId?: string; agentId?: string; limit?: number }): TaskLog[] {
    return this.store.getLogs(filter);
  }
}
