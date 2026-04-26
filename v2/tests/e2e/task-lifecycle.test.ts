import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dataDir: string;

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', join(__dirname, '../../src/index.ts'), ...args], {
    env: { ...process.env, AGENT_POOL_DATA_DIR: dataDir, NO_COLOR: '1', CMUX_WORKSPACE_ID: '' },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { stdout, stderr, exitCode };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ap-e2e-tl-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Task lifecycle', () => {
  test('add tasks with deps → check waiting → complete dep → eligible', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'deplife', '--source', source);

    // Add phase 1 task
    const r1 = await run('add', 'Phase 1: extract interfaces');
    const t1 = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    // Add phase 2 that depends on phase 1
    const r2 = await run('add', '--depends-on', t1, 'Phase 2: implement');
    const t2 = r2.stdout.match(/Added task (\S+)/)?.[1]!;
    expect(r2.stdout).toContain(`[deps: ${t1}]`);

    // Tasks listing should show waiting for t2
    let tasks = await run('tasks');
    expect(tasks.stdout).toContain('waiting (1)');

    // Complete the dependency
    await run('set-status', t1, 'completed');

    // Now t2 should show as regular pending (no waiting)
    tasks = await run('tasks');
    // t2 should not show waiting anymore since dep is completed
    const t2Line = tasks.stdout.split('\n').find(l => l.startsWith(t2));
    expect(t2Line).toContain('pending');
    expect(t2Line).not.toContain('waiting');

    rmSync(source, { recursive: true, force: true });
  });

  test('multiple dependencies', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'multidep', '--source', source);

    const r1 = await run('add', 'Task A');
    const tA = r1.stdout.match(/Added task (\S+)/)?.[1]!;
    const r2 = await run('add', 'Task B');
    const tB = r2.stdout.match(/Added task (\S+)/)?.[1]!;

    const r3 = await run('add', '--depends-on', `${tA},${tB}`, 'Task C depends on A and B');
    expect(r3.exitCode).toBe(0);
    expect(r3.stdout).toContain(`[deps: ${tA},${tB}]`);
    const tC = r3.stdout.match(/Added task (\S+)/)?.[1]!;

    // Should show waiting (2)
    let tasks = await run('tasks');
    expect(tasks.stdout).toContain('waiting (2)');

    // Complete A, should show waiting (1)
    await run('set-status', tA, 'completed');
    tasks = await run('tasks');
    expect(tasks.stdout).toContain('waiting (1)');

    // Complete B, should show pending (no waiting)
    await run('set-status', tB, 'completed');
    tasks = await run('tasks');
    const tCLine = tasks.stdout.split('\n').find(l => l.startsWith(tC));
    expect(tCLine).toContain('pending');
    expect(tCLine).not.toContain('waiting');

    rmSync(source, { recursive: true, force: true });
  });

  test('full status lifecycle: pending → in_progress → blocked → pending → completed', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'lifecycle', '--source', source);

    const r1 = await run('add', 'Lifecycle task');
    const taskId = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    // pending → in_progress
    await run('set-status', taskId, 'in_progress');
    let tasks = await run('tasks');
    expect(tasks.stdout).toContain('in_progress');

    // in_progress → blocked
    await run('set-status', taskId, 'blocked');
    tasks = await run('tasks');
    expect(tasks.stdout).toContain('blocked');

    // blocked → pending via unblock
    await run('unblock', taskId);
    tasks = await run('tasks');
    expect(tasks.stdout).toContain('pending');

    // pending → completed
    await run('set-status', taskId, 'completed');
    tasks = await run('tasks');
    expect(tasks.stdout).toContain('completed');

    rmSync(source, { recursive: true, force: true });
  });

  test('backlog lifecycle: pending → backlogged → pending', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'bklife', '--source', source);

    const r1 = await run('add', 'Backlog lifecycle');
    const taskId = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    await run('backlog', taskId);
    let tasks = await run('tasks');
    expect(tasks.stdout).toContain('backlogged');

    await run('activate', taskId);
    tasks = await run('tasks');
    expect(tasks.stdout).toContain('pending');

    rmSync(source, { recursive: true, force: true });
  });

  test('set-status with invalid status fails', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'badstat', '--source', source);

    const r1 = await run('add', 'Bad status');
    const taskId = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    const r = await run('set-status', taskId, 'invalid_status');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('invalid status');

    rmSync(source, { recursive: true, force: true });
  });

  test('unblock non-blocked task fails', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'ubfail', '--source', source);

    const r1 = await run('add', 'Not blocked');
    const taskId = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    const r = await run('unblock', taskId);
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not blocked');

    rmSync(source, { recursive: true, force: true });
  });

  test('tasks with no tasks shows empty message', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'emptyproj', '--source', source);

    const r = await run('tasks');
    expect(r.stdout).toContain('No tasks.');

    rmSync(source, { recursive: true, force: true });
  });

  test('set-status to completed then reset to pending', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'resetproj', '--source', source);

    const r1 = await run('add', 'Reset me');
    const taskId = r1.stdout.match(/Added task (\S+)/)?.[1]!;

    // Complete the task
    const r2 = await run('set-status', taskId, 'completed');
    expect(r2.exitCode).toBe(0);
    let tasks = await run('tasks');
    const completedLine = tasks.stdout.split('\n').find(l => l.startsWith(taskId));
    expect(completedLine).toContain('completed');

    // Reset back to pending
    const r3 = await run('set-status', taskId, 'pending');
    expect(r3.exitCode).toBe(0);
    tasks = await run('tasks');
    const pendingLine = tasks.stdout.split('\n').find(l => l.startsWith(taskId));
    expect(pendingLine).toContain('pending');
    expect(pendingLine).not.toContain('completed');

    rmSync(source, { recursive: true, force: true });
  });
});
