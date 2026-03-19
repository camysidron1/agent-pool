import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';
import { createApp } from '../../../src/app.js';

describe('next command', () => {
  let ctx: TestContext;
  let originalLog: typeof console.log;
  let output: string[];

  beforeEach(() => {
    ctx = createTestContext();
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
    output = [];
    originalLog = console.log;
    console.log = (...args: unknown[]) => output.push(args.join(' '));
  });

  afterEach(() => {
    console.log = originalLog;
    ctx.cleanup();
  });

  test('shows next claimable task', async () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'first task' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'second task' });

    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    expect(output.length).toBe(1);
    expect(output[0]).toContain('first task');
    expect(output[0]).toContain('pending');
  });

  test('respects priority ordering', async () => {
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'low prio', priority: 1 });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'high prio', priority: 10 });

    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    expect(output[0]).toContain('high prio');
    expect(output[0]).toContain('[priority: 10]');
  });

  test('skips tasks with unmet dependencies', async () => {
    const dep = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'dependency' });
    const blocked = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'blocked task', dependsOn: [dep.id] });

    // The dependency itself should be next (it has no deps)
    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    expect(output[0]).toContain('dependency');
    expect(output[0]).toContain(dep.id);
  });

  test('reports waiting tasks when all pending have unmet deps', async () => {
    const dep = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'dep task' });
    // Mark dep as in_progress so it's not claimable and not completed
    ctx.stores.tasks.mark(dep.id, 'in_progress');
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'waiting task', dependsOn: [dep.id] });

    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    expect(output[0]).toContain('waiting on dependencies');
    expect(output[0]).toContain('1 pending');
  });

  test('reports no claimable tasks when queue is empty', async () => {
    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    expect(output[0]).toBe('No claimable tasks');
  });

  test('does not mutate task state', async () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'should stay pending' });

    const app = createApp(ctx);
    await app.parseAsync(['node', 'agent-pool', 'next', '-p', 'proj']);

    // Verify task is still pending after peek
    const after = ctx.stores.tasks.get(task.id);
    expect(after!.status).toBe('pending');
    expect(after!.claimedBy).toBeNull();
    expect(after!.startedAt).toBeNull();
  });
});
