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

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), 'ap-e2e-pw-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('Project lifecycle', () => {
  test('add project → set tracking → set workflow → verify in list', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'fullproj', '--source', source, '--branch', 'develop');

    await run('project', 'set-tracking', 'fullproj', '--type', 'linear', '--key', 'PROJ-1', '--label', 'bug');
    await run('project', 'set-workflow', 'fullproj', '--type', 'pr', '--auto-merge', 'true', '--merge-method', 'squash');

    const r = await run('project', 'list');
    expect(r.stdout).toContain('fullproj');
    expect(r.stdout).toContain('develop');
    expect(r.stdout).toContain('Linear (PROJ-1)');
    expect(r.stdout).toContain('pr');

    rmSync(source, { recursive: true, force: true });
  });

  test('clear tracking and workflow', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'clearproj', '--source', source);
    await run('project', 'set-tracking', 'clearproj', '--type', 'jira', '--key', 'CL-1');
    await run('project', 'set-workflow', 'clearproj', '--type', 'branch');

    await run('project', 'clear-tracking', 'clearproj');
    await run('project', 'clear-workflow', 'clearproj');

    const r = await run('project', 'list');
    expect(r.stdout).not.toContain('tracking:');
    expect(r.stdout).not.toContain('workflow:');
    rmSync(source, { recursive: true, force: true });
  });

  test('multiple projects with different defaults', async () => {
    const s1 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    const s2 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    const s3 = mkdtempSync(join(tmpdir(), 'ap-src-'));

    await run('project', 'add', 'alpha', '--source', s1);
    await run('project', 'add', 'beta', '--source', s2);
    await run('project', 'add', 'gamma', '--source', s3);

    // First project should be default
    let r = await run('project', 'list');
    const lines = r.stdout.split('\n');
    const alphaLine = lines.find(l => l.includes('alpha'));
    expect(alphaLine).toContain('*');

    // Switch default
    await run('project', 'default', 'gamma');
    r = await run('project', 'list');
    const gammaLine = r.stdout.split('\n').find(l => l.includes('gamma'));
    expect(gammaLine).toContain('*');
    // alpha should no longer be default
    const alphaLine2 = r.stdout.split('\n').find(l => l.includes('alpha'));
    expect(alphaLine2).not.toContain('*');

    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
    rmSync(s3, { recursive: true, force: true });
  });

  test('project add with custom prefix and setup', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'custom', '--source', source, '--prefix', 'cx', '--setup', 'npm install');

    const r = await run('project', 'list');
    expect(r.stdout).toContain('cx');
    rmSync(source, { recursive: true, force: true });
  });
});
