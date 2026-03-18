import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

let dataDir: string;

async function run(...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  const proc = Bun.spawn(['bun', 'run', join(__dirname, '../../src/index.ts'), ...args], {
    env: { ...process.env, AGENT_POOL_DATA_DIR: dataDir, NO_COLOR: '1' },
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

function expectCleanError(result: { stdout: string; stderr: string; exitCode: number }, messageFragment: string) {
  expect(result.exitCode).toBe(1);
  expect(result.stderr).toContain('Error:');
  expect(result.stderr).toContain(messageFragment);
  // No stack traces
  expect(result.stderr).not.toContain('    at ');
  expect(result.stderr).not.toContain('.ts:');
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ap-e2e-err-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Error handling: no project configured', () => {
  test('tasks with no project → clean error', async () => {
    expectCleanError(await run('tasks'), 'No default project set');
  });

  test('add with no project → clean error', async () => {
    expectCleanError(await run('add', 'Some task'), 'No default project set');
  });

  test('status with no project → clean error', async () => {
    expectCleanError(await run('status'), 'No default project set');
  });
});

describe('Error handling: nonexistent project via -p', () => {
  test('-p nonexistent tasks → clean error', async () => {
    expectCleanError(await run('-p', 'nonexistent', 'tasks'), "Project 'nonexistent' not found");
  });

  test('-p nonexistent add → clean error', async () => {
    expectCleanError(await run('-p', 'nonexistent', 'add', 'foo'), "Project 'nonexistent' not found");
  });

  test('-p nonexistent status → clean error', async () => {
    expectCleanError(await run('-p', 'nonexistent', 'status'), "Project 'nonexistent' not found");
  });
});

describe('Error handling: project subcommands', () => {
  test('project remove nonexistent → error', async () => {
    expectCleanError(await run('project', 'remove', 'nonexistent'), "Project 'nonexistent' not found");
  });

  test('project default nonexistent → error', async () => {
    expectCleanError(await run('project', 'default', 'nonexistent'), "Project 'nonexistent' not found");
  });

  test('project set-tracking nonexistent → error', async () => {
    expectCleanError(
      await run('project', 'set-tracking', 'nonexistent', '--type', 'linear', '--key', 'X'),
      "Project 'nonexistent' not found",
    );
  });

  test('project set-workflow nonexistent → error', async () => {
    expectCleanError(
      await run('project', 'set-workflow', 'nonexistent', '--type', 'pr'),
      "Project 'nonexistent' not found",
    );
  });

  test('project clear-tracking nonexistent → error', async () => {
    expectCleanError(await run('project', 'clear-tracking', 'nonexistent'), "Project 'nonexistent' not found");
  });

  test('project clear-workflow nonexistent → error', async () => {
    expectCleanError(await run('project', 'clear-workflow', 'nonexistent'), "Project 'nonexistent' not found");
  });
});

describe('Error handling: task operations on nonexistent tasks', () => {
  let source: string;

  beforeEach(async () => {
    source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'errproj', '--source', source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
  });

  test('unblock nonexistent task → error', async () => {
    expectCleanError(await run('unblock', 't-nonexistent'), "not found");
  });

  test('backlog nonexistent task → error', async () => {
    expectCleanError(await run('backlog', 't-nonexistent'), "not found");
  });

  test('activate nonexistent task → error', async () => {
    expectCleanError(await run('activate', 't-nonexistent'), "not found");
  });

  test('set-status nonexistent task → error', async () => {
    expectCleanError(await run('set-status', 't-nonexistent', 'completed'), "not found");
  });

  test('set-status with invalid status → error', async () => {
    const r1 = await run('add', 'Test task');
    const taskId = r1.stdout.match(/t-\d+-\d+/)?.[0]!;
    const r = await run('set-status', taskId, 'invalid_status');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('invalid status');
  });

  test('add --depends-on nonexistent → error', async () => {
    const r = await run('add', '--depends-on', 't-nonexistent', 'Dep task');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not found');
  });
});

describe('Error output format', () => {
  test('errors go to stderr, not stdout', async () => {
    const r = await run('tasks');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('Error:');
    // stdout should be empty or not contain the error
    expect(r.stdout).not.toContain('Error:');
  });

  test('error messages do not contain stack traces', async () => {
    const r = await run('-p', 'nonexistent', 'status');
    expect(r.exitCode).toBe(1);
    // Stack trace indicators
    expect(r.stderr).not.toContain('    at ');
    expect(r.stderr).not.toContain('TypeError');
    expect(r.stderr).not.toContain('ReferenceError');
  });
});
