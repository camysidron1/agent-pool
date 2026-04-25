import { describe, test, expect, beforeEach } from 'bun:test';
import { createPiTools } from '../../../src/adapters/pi/tools.js';
import type { TaskStore, Task, TaskInput, TaskStatus, TaskLog } from '../../../src/stores/interfaces.js';
import type { ToolDefinition } from '@mariozechner/pi-coding-agent';

// Minimal mock TaskStore that tracks calls
class MockTaskStore implements TaskStore {
  tasks: Task[] = [];
  private nextId = 1;
  markCalls: Array<{ id: string; status: TaskStatus; fields?: Partial<Task> }> = [];

  add(input: TaskInput): Task {
    const task: Task = {
      id: `t-${this.nextId++}`,
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
      pipelineId: input.pipelineId ?? null,
      pipelineStepId: input.pipelineStepId ?? null,
    };
    this.tasks.push(task);
    return task;
  }

  getAll(projectName: string): Task[] {
    return this.tasks.filter(t => t.projectName === projectName);
  }

  get(id: string): Task | null {
    return this.tasks.find(t => t.id === id) ?? null;
  }

  mark(id: string, status: TaskStatus, fields?: Partial<Task>): void {
    this.markCalls.push({ id, status, fields });
    const task = this.tasks.find(t => t.id === id);
    if (task) {
      task.status = status;
      if (fields?.result) task.result = fields.result;
    }
  }

  claim() { return null; }
  updateFields() {}
  getDependencies() { return []; }
  addDependency() {}
  addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog { return { ...log, id: 1, createdAt: new Date().toISOString() }; }
  getLogs() { return []; }
  releaseAgent() { return 0; }
  getByPipeline() { return []; }
}

// Stub ExtensionContext — tools don't use most of it
const stubExtCtx = {
  ui: {} as any,
  hasUI: false,
  cwd: '/tmp',
  sessionManager: {} as any,
  modelRegistry: {} as any,
  model: undefined,
  isIdle: () => true,
  signal: undefined,
  abort: () => {},
  hasPendingMessages: () => false,
  shutdown: () => {},
} as any;

function findTool(tools: ToolDefinition[], name: string): ToolDefinition {
  const tool = tools.find(t => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

describe('Pi Tools', () => {
  let store: MockTaskStore;

  beforeEach(() => {
    store = new MockTaskStore();
  });

  describe('create_task', () => {
    test('creates a task with correct project name', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'create_task');

      const result = await tool.execute('call-1', { prompt: 'Fix the bug' }, undefined, undefined, stubExtCtx);
      expect(result.content[0]).toEqual(expect.objectContaining({ type: 'text' }));

      expect(store.tasks).toHaveLength(1);
      expect(store.tasks[0].projectName).toBe('myproj');
      expect(store.tasks[0].prompt).toBe('Fix the bug');
      expect(store.tasks[0].priority).toBe(0);
    });

    test('respects custom priority', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'create_task');

      await tool.execute('call-1', { prompt: 'Urgent task', priority: 100 }, undefined, undefined, stubExtCtx);
      expect(store.tasks[0].priority).toBe(100);
    });

    test('enforces rate limit', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
        policy: { maxTasksPerExecution: 2 },
      });
      const tool = findTool(tools, 'create_task');

      await tool.execute('c1', { prompt: 'Task 1' }, undefined, undefined, stubExtCtx);
      await tool.execute('c2', { prompt: 'Task 2' }, undefined, undefined, stubExtCtx);
      const result = await tool.execute('c3', { prompt: 'Task 3' }, undefined, undefined, stubExtCtx);

      expect(store.tasks).toHaveLength(2);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Rate limit');
    });
  });

  describe('list_tasks', () => {
    test('lists all tasks for the project', async () => {
      store.add({ projectName: 'myproj', prompt: 'Task A' });
      store.add({ projectName: 'myproj', prompt: 'Task B' });
      store.add({ projectName: 'other', prompt: 'Task C' });

      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'list_tasks');

      const result = await tool.execute('call-1', {}, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Task A');
      expect(text).toContain('Task B');
      expect(text).not.toContain('Task C');
    });

    test('filters by status', async () => {
      const t = store.add({ projectName: 'myproj', prompt: 'Pending one' });
      store.add({ projectName: 'myproj', prompt: 'Done one' });
      store.tasks[1].status = 'completed';

      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'list_tasks');

      const result = await tool.execute('call-1', { status: 'completed' }, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Done one');
      expect(text).not.toContain('Pending one');
    });

    test('returns empty message when no tasks', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'list_tasks');

      const result = await tool.execute('call-1', {}, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('No tasks');
    });
  });

  describe('get_task_status', () => {
    test('returns task details', async () => {
      const task = store.add({ projectName: 'myproj', prompt: 'Do something' });

      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'get_task_status');

      const result = await tool.execute('call-1', { taskId: task.id }, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain(task.id);
      expect(text).toContain('pending');
      expect(text).toContain('Do something');
    });

    test('returns not found for unknown task', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-current',
      });
      const tool = findTool(tools, 'get_task_status');

      const result = await tool.execute('call-1', { taskId: 't-nonexistent' }, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('not found');
    });
  });

  describe('finish_task', () => {
    test('marks the current task completed', async () => {
      store.add({ projectName: 'myproj', prompt: 'Current task' });

      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-1',
      });
      const tool = findTool(tools, 'finish_task');

      // Provide an abort function on the stub context
      let aborted = false;
      const ctx = { ...stubExtCtx, abort: () => { aborted = true; } };

      const result = await tool.execute('call-1', { status: 'completed' }, undefined, undefined, ctx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('completed');
      expect(store.markCalls[0]).toEqual({ id: 't-1', status: 'completed', fields: undefined });
      expect(aborted).toBe(true);
    });

    test('marks task blocked with result message', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-1',
      });
      const tool = findTool(tools, 'finish_task');
      let aborted = false;
      const ctx = { ...stubExtCtx, abort: () => { aborted = true; } };

      await tool.execute('call-1', { status: 'blocked', result: 'Missing API key' }, undefined, undefined, ctx);
      expect(store.markCalls[0]).toEqual({ id: 't-1', status: 'blocked', fields: { result: 'Missing API key' } });
    });

    test('rejects invalid status', async () => {
      const tools = createPiTools({
        taskStore: store,
        projectName: 'myproj',
        agentId: 'agent-01',
        taskId: 't-1',
      });
      const tool = findTool(tools, 'finish_task');

      const result = await tool.execute('call-1', { status: 'invalid' }, undefined, undefined, stubExtCtx);
      const text = (result.content[0] as any).text;
      expect(text).toContain('Invalid status');
      expect(store.markCalls).toHaveLength(0);
    });
  });
});
