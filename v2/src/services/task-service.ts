import type { TaskStore, TaskInput, Task, TaskLog, TaskStatus } from '../stores/interfaces.js';

export interface QueueSummary {
  total: number;
  pending: number;
  inProgress: number;
  blocked: number;
  waitingOnDeps: number;
  claimable: number;
  completed: number;
  backlogged: number;
  cancelled: number;
  nextClaimable: Task | null;
}

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

  next(projectName: string): Task | null {
    return this.store.peek(projectName);
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

  getQueueSummary(projectName: string): QueueSummary {
    const tasks = this.store.getAll(projectName);
    const summary: QueueSummary = {
      total: tasks.length,
      pending: 0,
      inProgress: 0,
      blocked: 0,
      waitingOnDeps: 0,
      claimable: 0,
      completed: 0,
      backlogged: 0,
      cancelled: 0,
      nextClaimable: null,
    };

    // Collect claimable tasks to sort by priority/creation
    const claimableTasks: Task[] = [];

    for (const task of tasks) {
      switch (task.status) {
        case 'in_progress': summary.inProgress++; break;
        case 'blocked': summary.blocked++; break;
        case 'completed': summary.completed++; break;
        case 'backlogged': summary.backlogged++; break;
        case 'cancelled': summary.cancelled++; break;
        case 'pending': {
          summary.pending++;
          const deps = this.store.getDependencies(task.id);
          const hasUnmetDeps = deps.some(depId => {
            const dep = this.store.get(depId);
            return dep && dep.status !== 'completed';
          });
          if (hasUnmetDeps) {
            summary.waitingOnDeps++;
          } else {
            summary.claimable++;
            claimableTasks.push(task);
          }
          break;
        }
      }
    }

    // Match claim() ordering: priority DESC, createdAt ASC
    if (claimableTasks.length > 0) {
      claimableTasks.sort((a, b) => {
        if (b.priority !== a.priority) return b.priority - a.priority;
        return a.createdAt.localeCompare(b.createdAt);
      });
      summary.nextClaimable = claimableTasks[0];
    }

    return summary;
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
