import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { spawnSync } from 'child_process';

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

function createGitRepo(): string {
  const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
  spawnSync('git', ['init'], { cwd: source });
  spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: source });
  spawnSync('git', ['config', 'user.name', 'Test'], { cwd: source });
  writeFileSync(join(source, 'README.md'), '# Test\n');
  spawnSync('git', ['add', '.'], { cwd: source });
  spawnSync('git', ['commit', '-m', 'init'], { cwd: source });
  return source;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ap-e2e-cmd-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('logs command', () => {
  test('logs with no logs → shows no logs message', async () => {
    const r = await run('logs');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No logs found');
  });

  test('logs --last limits output', async () => {
    const r = await run('logs', '--last', '5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No logs found');
  });

  test('logs --agent filters output', async () => {
    const r = await run('logs', '--agent', 'agent-99');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No logs found');
  });
});

describe('refresh command', () => {
  test('refresh without args or --all → error', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'refproj', '--source', source);
    await run('init', '-n', '1');

    const r = await run('refresh');
    expect(r.exitCode).toBe(1);
    rmSync(source, { recursive: true, force: true });
  });

  test('refresh --all with no clones → message', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'refproj2', '--source', source);

    const r = await run('refresh', '--all');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No clones');
    rmSync(source, { recursive: true, force: true });
  });

  test('refresh nonexistent clone index → error', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'refproj3', '--source', source);
    await run('init', '-n', '1');

    const r = await run('refresh', '99');
    expect(r.exitCode).toBe(1);
    rmSync(source, { recursive: true, force: true });
  });

  test('refresh single clone works', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'refproj4', '--source', source);
    await run('init', '-n', '1');

    const r = await run('refresh', '0');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Refreshed clone 0');
    rmSync(source, { recursive: true, force: true });
  });

  test('refresh --all refreshes all clones', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'refproj5', '--source', source);
    await run('init', '-n', '2');

    const r = await run('refresh', '--all');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Refreshed 2 clones');
    rmSync(source, { recursive: true, force: true });
  });
});

describe('release command', () => {
  test('release a clone', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'relproj', '--source', source);
    await run('init', '-n', '1');

    const r = await run('release', '0');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Released clone 0');
    rmSync(source, { recursive: true, force: true });
  });

  test('release nonexistent clone → error', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'relproj2', '--source', source);
    await run('init', '-n', '1');

    const r = await run('release', '99');
    expect(r.exitCode).toBe(1);
    rmSync(source, { recursive: true, force: true });
  });
});

describe('destroy command', () => {
  test('destroy all clones', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'destrproj', '--source', source);
    await run('init', '-n', '2');

    const r = await run('destroy');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Destroyed 2 clones');
    rmSync(source, { recursive: true, force: true });
  });

  test('destroy when no clones → message', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'destrproj2', '--source', source);

    const r = await run('destroy');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No clones');
    rmSync(source, { recursive: true, force: true });
  });
});

describe('integration command', () => {
  test('integration list with no integrations', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'intproj', '--source', source);

    const r = await run('integration', 'list');
    expect(r.exitCode).toBe(0);
    rmSync(source, { recursive: true, force: true });
  });
});

describe('daemon command', () => {
  test('daemon status when not running', async () => {
    const r = await run('daemon', 'status');
    expect(r.exitCode).toBe(0);
    // Should indicate no daemon running
    const output = r.stdout + r.stderr;
    expect(output.toLowerCase()).toMatch(/no.*running|not running|no running/i);
  });

  test('daemon stop when not running', async () => {
    const r = await run('daemon', 'stop');
    // Should handle gracefully
    expect([0, 1]).toContain(r.exitCode);
  });
});

describe('restart command', () => {
  test('restart nonexistent clone → error', async () => {
    const source = createGitRepo();
    await run('project', 'add', 'restproj', '--source', source);
    await run('init', '-n', '1');

    const r = await run('restart', '99');
    expect(r.exitCode).toBe(1);
    rmSync(source, { recursive: true, force: true });
  });
});

describe('add command options', () => {
  let source: string;

  beforeEach(async () => {
    source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'optproj', '--source', source);
  });

  afterEach(() => {
    rmSync(source, { recursive: true, force: true });
  });

  test('add with --priority', async () => {
    const r = await run('add', '--priority', '10', 'High priority task');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added task');
  });

  test('add with --timeout', async () => {
    const r = await run('add', '--timeout', '60', 'Timed task');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added task');
  });

  test('add with --retry and --retry-strategy', async () => {
    const r = await run('add', '--retry', '3', '--retry-strategy', 'augmented', 'Retryable task');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added task');
  });

  test('add with all options combined', async () => {
    const r = await run(
      'add',
      '--priority', '5',
      '--timeout', '30',
      '--retry', '2',
      '--retry-strategy', 'escalate',
      '--backlog',
      'Full options task',
    );
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added task');
    expect(r.stdout).toContain('(backlogged)');
  });
});
