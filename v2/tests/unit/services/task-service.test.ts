import { describe, test, expect, beforeEach } from 'bun:test';
import { TaskService } from '../../../src/services/task-service.js';
import type { TaskStore, TaskInput, Task, TaskLog, TaskStatus } from '../../../src/stores/interfaces.js';

class MockTaskStore implements TaskStore {
  tasks: Task[] = [];
  dependencies: Map<string, string[]> = new Map();
  logs: TaskLog[] = [];
  private counter = 0;

  getAll(projectName: string): Task[] {
    return this.tasks.filter(t => t.projectName === projectName);
  }

  get(id: string): Task | null {
    return this.tasks.find(t => t.id === id) ?? null;
  }

  add(input: TaskInput): Task {
    this.counter++;
    const task: Task = {
      id: `t-${this.counter}`,
      projectName: input.projectName,
      prompt: input.prompt,
      status: input.status ?? 'pending',
      claimedBy: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      priority: input.priority ?? 0,
      timeoutMinutes: input.timeoutMinutes ?? null,
      retryMax: input.retryMax ?? 1,
      retryCount: 0,
      retryStrategy: input.retryStrategy ?? 'same',
      result: null,
    };
    this.tasks.push(task);
    if (input.dependsOn) {
      this.dependencies.set(task.id, [...input.dependsOn]);
    }
    return task;
  }

  peek(projectName: string): Task | null {
    return this.tasks.find(t => t.projectName === projectName && t.status === 'pending') ?? null;
  }

  claim(projectName: string, agentId: string): Task | null {
    const task = this.tasks.find(t => t.projectName === projectName && t.status === 'pending');
    if (!task) return null;
    task.status = 'in_progress';
    task.claimedBy = agentId;
    task.startedAt = new Date().toISOString();
    return task;
  }

  mark(id: string, status: TaskStatus, fields?: Partial<Task>): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      task.status = status;
      if (fields) {
        if ('claimedBy' in fields) task.claimedBy = fields.claimedBy ?? null;
        if ('startedAt' in fields) task.startedAt = fields.startedAt ?? null;
        if ('completedAt' in fields) task.completedAt = fields.completedAt ?? null;
      }
    }
  }

  updateFields(id: string, fields: Partial<Pick<Task, 'priority' | 'timeoutMinutes' | 'retryMax' | 'retryStrategy' | 'result' | 'prompt' | 'retryCount'>>): void {
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      Object.assign(task, fields);
    }
  }

  getDependencies(taskId: string): string[] {
    return this.dependencies.get(taskId) ?? [];
  }

  addDependency(taskId: string, dependsOn: string): void {
    const deps = this.dependencies.get(taskId) ?? [];
    deps.push(dependsOn);
    this.dependencies.set(taskId, deps);
  }

  addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog {
    const entry: TaskLog = { ...log, id: this.logs.length + 1, createdAt: new Date().toISOString() };
    this.logs.push(entry);
    return entry;
  }

  getLogs(filter: { taskId?: string; agentId?: string; limit?: number }): TaskLog[] {
    let result = [...this.logs];
    if (filter.taskId) result = result.filter(l => l.taskId === filter.taskId);
    if (filter.agentId) result = result.filter(l => l.agentId === filter.agentId);
    if (filter.limit) result = result.slice(0, filter.limit);
    return result;
  }
}

describe('TaskService', () => {
  let store: MockTaskStore;
  let service: TaskService;

  beforeEach(() => {
    store = new MockTaskStore();
    service = new TaskService(store);
  });

  describe('add', () => {
    test('adds a task and returns it', () => {
      const task = service.add({ projectName: 'proj', prompt: 'do something' });
      expect(task.id).toBe('t-1');
      expect(task.prompt).toBe('do something');
      expect(task.status).toBe('pending');
    });
  });

  describe('list', () => {
    test('returns tasks for a project', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.add({ projectName: 'proj', prompt: 'b' });
      service.add({ projectName: 'other', prompt: 'c' });

      expect(service.list('proj')).toHaveLength(2);
      expect(service.list('other')).toHaveLength(1);
    });
  });

  describe('get', () => {
    test('returns task by id', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      expect(service.get('t-1')?.prompt).toBe('a');
    });

    test('returns null for unknown id', () => {
      expect(service.get('t-999')).toBeNull();
    });
  });

  describe('claim', () => {
    test('claims first pending task', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      const claimed = service.claim('proj', 'agent-1');
      expect(claimed).not.toBeNull();
      expect(claimed!.status).toBe('in_progress');
      expect(claimed!.claimedBy).toBe('agent-1');
    });

    test('returns null when no pending tasks', () => {
      expect(service.claim('proj', 'agent-1')).toBeNull();
    });
  });

  describe('mark', () => {
    test('updates task status', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.mark('t-1', 'completed');
      expect(store.get('t-1')!.status).toBe('completed');
    });
  });

  describe('unblock', () => {
    test('unblocks a blocked task', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      store.mark('t-1', 'blocked');
      service.unblock('t-1');

      const task = store.get('t-1')!;
      expect(task.status).toBe('pending');
      expect(task.claimedBy).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    test('throws if task is not blocked', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      expect(() => service.unblock('t-1')).toThrow('is not blocked');
    });

    test('throws if task not found', () => {
      expect(() => service.unblock('t-999')).toThrow("Task 't-999' not found");
    });
  });

  describe('backlog', () => {
    test('backlogs a pending task', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.backlog('t-1');
      expect(store.get('t-1')!.status).toBe('backlogged');
    });

    test('backlogs an already backlogged task (idempotent)', () => {
      service.add({ projectName: 'proj', prompt: 'a', status: 'backlogged' });
      service.backlog('t-1');
      expect(store.get('t-1')!.status).toBe('backlogged');
    });

    test('throws if task is in_progress', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      store.mark('t-1', 'in_progress');
      expect(() => service.backlog('t-1')).toThrow('must be backlogged or pending');
    });

    test('throws if task not found', () => {
      expect(() => service.backlog('t-999')).toThrow("Task 't-999' not found");
    });
  });

  describe('activate', () => {
    test('activates a backlogged task', () => {
      service.add({ projectName: 'proj', prompt: 'a', status: 'backlogged' });
      service.activate('t-1');
      expect(store.get('t-1')!.status).toBe('pending');
    });

    test('throws if task is not backlogged', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      expect(() => service.activate('t-1')).toThrow('is not backlogged');
    });

    test('throws if task not found', () => {
      expect(() => service.activate('t-999')).toThrow("Task 't-999' not found");
    });
  });

  describe('setStatus', () => {
    test('sets to pending and clears fields', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      store.mark('t-1', 'in_progress', { claimedBy: 'agent-1', startedAt: new Date().toISOString() });

      service.setStatus('t-1', 'pending');
      const task = store.get('t-1')!;
      expect(task.status).toBe('pending');
      expect(task.claimedBy).toBeNull();
      expect(task.startedAt).toBeNull();
      expect(task.completedAt).toBeNull();
    });

    test('sets to backlogged and clears fields', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.setStatus('t-1', 'backlogged');
      const task = store.get('t-1')!;
      expect(task.status).toBe('backlogged');
      expect(task.claimedBy).toBeNull();
    });

    test('sets to completed with completedAt', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.setStatus('t-1', 'completed');
      const task = store.get('t-1')!;
      expect(task.status).toBe('completed');
      expect(task.completedAt).not.toBeNull();
    });

    test('sets to blocked with completedAt', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.setStatus('t-1', 'blocked');
      const task = store.get('t-1')!;
      expect(task.status).toBe('blocked');
      expect(task.completedAt).not.toBeNull();
    });

    test('sets to in_progress without extra fields', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.setStatus('t-1', 'in_progress');
      expect(store.get('t-1')!.status).toBe('in_progress');
    });

    test('throws if task not found', () => {
      expect(() => service.setStatus('t-999', 'pending')).toThrow("Task 't-999' not found");
    });
  });

  describe('getDependencies', () => {
    test('returns dependencies for a task', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      service.add({ projectName: 'proj', prompt: 'b', dependsOn: ['t-1'] });

      expect(service.getDependencies('t-2')).toEqual(['t-1']);
    });

    test('returns empty array when no dependencies', () => {
      service.add({ projectName: 'proj', prompt: 'a' });
      expect(service.getDependencies('t-1')).toEqual([]);
    });
  });
});
