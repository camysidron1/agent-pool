import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';

describe('SqliteTaskStore', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  test('add task and verify generated ID format', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'do something' });
    expect(task.id).toMatch(/^t-\d+/);
    expect(task.projectName).toBe('proj');
    expect(task.prompt).toBe('do something');
    expect(task.status).toBe('pending');
    expect(task.claimedBy).toBeNull();
    expect(task.createdAt).toBeTruthy();
    expect(task.startedAt).toBeNull();
    expect(task.completedAt).toBeNull();
  });

  test('add task with custom status', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'blocked task', status: 'backlogged' });
    expect(task.status).toBe('backlogged');
  });

  test('add task with dependencies', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'first' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'second', dependsOn: [t1.id] });
    const deps = ctx.stores.tasks.getDependencies(t2.id);
    expect(deps).toEqual([t1.id]);
  });

  test('add task with invalid dependency throws', () => {
    expect(() => {
      ctx.stores.tasks.add({ projectName: 'proj', prompt: 'bad', dependsOn: ['t-nonexistent'] });
    }).toThrow(/does not exist/);
  });

  test('getAll returns project-scoped tasks ordered by created_at', () => {
    ctx.stores.projects.add({ name: 'other', source: '/other' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    ctx.stores.tasks.add({ projectName: 'other', prompt: 'b' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'c' });

    const tasks = ctx.stores.tasks.getAll('proj');
    expect(tasks.length).toBe(2);
    expect(tasks[0].prompt).toBe('a');
    expect(tasks[1].prompt).toBe('c');
  });

  test('get returns task by id', () => {
    const created = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'test' });
    const fetched = ctx.stores.tasks.get(created.id);
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe(created.id);
  });

  test('get returns null for missing id', () => {
    expect(ctx.stores.tasks.get('t-999')).toBeNull();
  });

  test('claim picks first eligible pending task', () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'first' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'second' });

    const claimed = ctx.stores.tasks.claim('proj', 'agent-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.prompt).toBe('first');
    expect(claimed!.status).toBe('in_progress');
    expect(claimed!.claimedBy).toBe('agent-1');
    expect(claimed!.startedAt).not.toBeNull();
  });

  test('claim skips tasks with unmet dependencies', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'dep task' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'dependent', dependsOn: [t1.id] });

    // t1 is pending, so dependent task should be skipped; t1 should be claimed
    const claimed = ctx.stores.tasks.claim('proj', 'agent-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.prompt).toBe('dep task');

    // Now dependent task still can't be claimed because t1 is in_progress, not completed
    const claimed2 = ctx.stores.tasks.claim('proj', 'agent-2');
    expect(claimed2).toBeNull();

    // Complete t1
    ctx.stores.tasks.mark(t1.id, 'completed');

    // Now the dependent task can be claimed
    const claimed3 = ctx.stores.tasks.claim('proj', 'agent-2');
    expect(claimed3).not.toBeNull();
    expect(claimed3!.prompt).toBe('dependent');
  });

  test('claim returns null when no eligible tasks', () => {
    expect(ctx.stores.tasks.claim('proj', 'agent-1')).toBeNull();
  });

  test('claim returns null when all tasks are in_progress', () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'busy' });
    ctx.stores.tasks.claim('proj', 'agent-1');
    expect(ctx.stores.tasks.claim('proj', 'agent-2')).toBeNull();
  });

  test('mark sets status and completed_at for completed', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'test' });
    ctx.stores.tasks.mark(task.id, 'completed');
    const updated = ctx.stores.tasks.get(task.id)!;
    expect(updated.status).toBe('completed');
    expect(updated.completedAt).not.toBeNull();
  });

  test('mark sets completed_at for blocked', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'test' });
    ctx.stores.tasks.mark(task.id, 'blocked');
    const updated = ctx.stores.tasks.get(task.id)!;
    expect(updated.status).toBe('blocked');
    expect(updated.completedAt).not.toBeNull();
  });

  test('mark with additional fields', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'test' });
    ctx.stores.tasks.mark(task.id, 'in_progress', { claimedBy: 'agent-x' });
    const updated = ctx.stores.tasks.get(task.id)!;
    expect(updated.status).toBe('in_progress');
    expect(updated.claimedBy).toBe('agent-x');
  });

  test('getDependencies returns correct IDs', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b' });
    const t3 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'c', dependsOn: [t1.id, t2.id] });
    const deps = ctx.stores.tasks.getDependencies(t3.id);
    expect(deps.sort()).toEqual([t1.id, t2.id].sort());
  });

  test('getDependencies returns empty for task with no deps', () => {
    const t = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'solo' });
    expect(ctx.stores.tasks.getDependencies(t.id)).toEqual([]);
  });

  test('addDependency adds a new dependency link', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b' });
    ctx.stores.tasks.addDependency(t2.id, t1.id);
    expect(ctx.stores.tasks.getDependencies(t2.id)).toEqual([t1.id]);
  });

  // --- Phase 2: New fields ---

  test('add task has default values for new fields', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'basic' });
    expect(task.priority).toBe(0);
    expect(task.timeoutMinutes).toBeNull();
    expect(task.retryMax).toBe(1);
    expect(task.retryCount).toBe(0);
    expect(task.retryStrategy).toBe('same');
    expect(task.result).toBeNull();
  });

  test('add task with priority', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'high prio', priority: 10 });
    expect(task.priority).toBe(10);
  });

  test('add task with timeout', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'timed', timeoutMinutes: 30 });
    expect(task.timeoutMinutes).toBe(30);
  });

  test('add task with retry config', () => {
    const task = ctx.stores.tasks.add({
      projectName: 'proj',
      prompt: 'retryable',
      retryMax: 3,
      retryStrategy: 'augmented',
    });
    expect(task.retryMax).toBe(3);
    expect(task.retryCount).toBe(0);
    expect(task.retryStrategy).toBe('augmented');
  });

  test('new fields round-trip via add/get', () => {
    const added = ctx.stores.tasks.add({
      projectName: 'proj',
      prompt: 'round trip',
      priority: 5,
      timeoutMinutes: 60,
      retryMax: 2,
      retryStrategy: 'escalate',
    });

    const fetched = ctx.stores.tasks.get(added.id)!;
    expect(fetched.priority).toBe(5);
    expect(fetched.timeoutMinutes).toBe(60);
    expect(fetched.retryMax).toBe(2);
    expect(fetched.retryStrategy).toBe('escalate');
    expect(fetched.retryCount).toBe(0);
    expect(fetched.result).toBeNull();
  });

  test('claim prefers higher priority tasks', () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'low prio', priority: 1 });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'high prio', priority: 10 });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'mid prio', priority: 5 });

    const claimed = ctx.stores.tasks.claim('proj', 'agent-1');
    expect(claimed).not.toBeNull();
    expect(claimed!.prompt).toBe('high prio');

    const claimed2 = ctx.stores.tasks.claim('proj', 'agent-2');
    expect(claimed2!.prompt).toBe('mid prio');

    const claimed3 = ctx.stores.tasks.claim('proj', 'agent-3');
    expect(claimed3!.prompt).toBe('low prio');
  });

  test('claim uses created_at as tiebreaker for same priority', () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'first', priority: 5 });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'second', priority: 5 });

    const claimed = ctx.stores.tasks.claim('proj', 'agent-1');
    expect(claimed!.prompt).toBe('first');
  });

  test('cancelled status transition', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'cancel me' });
    ctx.stores.tasks.mark(task.id, 'cancelled');
    const updated = ctx.stores.tasks.get(task.id)!;
    expect(updated.status).toBe('cancelled');
    expect(updated.completedAt).not.toBeNull();
  });

  test('updateFields updates priority', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'x' });
    ctx.stores.tasks.updateFields(task.id, { priority: 99 });
    expect(ctx.stores.tasks.get(task.id)!.priority).toBe(99);
  });

  test('updateFields updates multiple fields', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'x' });
    ctx.stores.tasks.updateFields(task.id, {
      retryMax: 5,
      retryStrategy: 'escalate',
      result: 'timeout',
    });
    const updated = ctx.stores.tasks.get(task.id)!;
    expect(updated.retryMax).toBe(5);
    expect(updated.retryStrategy).toBe('escalate');
    expect(updated.result).toBe('timeout');
  });

  test('updateFields with retryCount', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'x', retryMax: 3 });
    ctx.stores.tasks.updateFields(task.id, { retryCount: 2 });
    expect(ctx.stores.tasks.get(task.id)!.retryCount).toBe(2);
  });

  // --- TaskLog CRUD ---

  test('addLog creates a log entry', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'logged' });
    const log = ctx.stores.tasks.addLog({
      taskId: task.id,
      agentId: 'agent-01',
      logPath: '/tmp/logs/agent-01/t-1.log',
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:05:00Z',
      exitCode: 0,
    });
    expect(log.id).toBeDefined();
    expect(log.taskId).toBe(task.id);
    expect(log.agentId).toBe('agent-01');
    expect(log.exitCode).toBe(0);
    expect(log.createdAt).toBeTruthy();
  });

  test('getLogs by taskId', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b' });
    ctx.stores.tasks.addLog({ taskId: t1.id, agentId: 'agent-01', logPath: '/a', startedAt: '2025-01-01T00:00:00Z', completedAt: null, exitCode: null });
    ctx.stores.tasks.addLog({ taskId: t2.id, agentId: 'agent-02', logPath: '/b', startedAt: '2025-01-01T00:00:00Z', completedAt: null, exitCode: null });

    const logs = ctx.stores.tasks.getLogs({ taskId: t1.id });
    expect(logs).toHaveLength(1);
    expect(logs[0].taskId).toBe(t1.id);
  });

  test('getLogs by agentId', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    ctx.stores.tasks.addLog({ taskId: t1.id, agentId: 'agent-01', logPath: '/a', startedAt: '2025-01-01T00:00:00Z', completedAt: null, exitCode: null });
    ctx.stores.tasks.addLog({ taskId: t1.id, agentId: 'agent-02', logPath: '/b', startedAt: '2025-01-01T00:00:00Z', completedAt: null, exitCode: null });

    const logs = ctx.stores.tasks.getLogs({ agentId: 'agent-01' });
    expect(logs).toHaveLength(1);
    expect(logs[0].agentId).toBe('agent-01');
  });

  test('getLogs with limit', () => {
    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a' });
    for (let i = 0; i < 5; i++) {
      ctx.stores.tasks.addLog({ taskId: t1.id, agentId: 'agent-01', logPath: `/log-${i}`, startedAt: '2025-01-01T00:00:00Z', completedAt: null, exitCode: null });
    }

    const logs = ctx.stores.tasks.getLogs({ taskId: t1.id, limit: 3 });
    expect(logs).toHaveLength(3);
  });

  test('getLogs returns empty for no matches', () => {
    expect(ctx.stores.tasks.getLogs({ taskId: 't-nonexistent' })).toEqual([]);
  });

  test('peek returns next claimable task without mutating state', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'peekable' });

    const peeked = ctx.stores.tasks.peek('proj');
    expect(peeked).not.toBeNull();
    expect(peeked!.id).toBe(task.id);
    expect(peeked!.status).toBe('pending');

    // Verify no mutation
    const after = ctx.stores.tasks.get(task.id)!;
    expect(after.status).toBe('pending');
    expect(after.claimedBy).toBeNull();
  });

  test('peek returns same task as claim would select', () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'low', priority: 1 });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'high', priority: 10 });

    const peeked = ctx.stores.tasks.peek('proj');
    expect(peeked!.prompt).toBe('high');

    // Claim should select the same task
    const claimed = ctx.stores.tasks.claim('proj', 'agent-1');
    expect(claimed!.id).toBe(peeked!.id);
  });

  test('peek skips tasks with unmet dependencies', () => {
    const dep = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'dep' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'waiting', dependsOn: [dep.id] });

    const peeked = ctx.stores.tasks.peek('proj');
    expect(peeked!.id).toBe(dep.id);
  });

  test('peek returns null when no claimable tasks', () => {
    expect(ctx.stores.tasks.peek('proj')).toBeNull();
  });
});
