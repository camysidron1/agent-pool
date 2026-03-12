import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createV1Fixtures } from '../fixtures/v1-data.js';

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
  dataDir = mkdtempSync(join(tmpdir(), 'ap-e2e-'));
});

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true });
});

describe('CLI e2e', () => {
  test('project add then list shows the project', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    const r1 = await run('project', 'add', 'myproj', '--source', source);
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toContain("Added project 'myproj'");

    const r2 = await run('project', 'list');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('myproj');
    expect(r2.stdout).toContain(source);
    rmSync(source, { recursive: true, force: true });
  });

  test('project default changes the default', async () => {
    const s1 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    const s2 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'proj1', '--source', s1);
    await run('project', 'add', 'proj2', '--source', s2);

    const r1 = await run('project', 'list');
    expect(r1.stdout).toContain('proj1');
    expect(r1.stdout).toContain('*');

    await run('project', 'default', 'proj2');
    const r2 = await run('project', 'list');
    // proj2 should now be default
    const lines = r2.stdout.split('\n');
    const proj2Line = lines.find(l => l.includes('proj2'));
    expect(proj2Line).toContain('*');

    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
  });

  test('project remove removes it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'gone', '--source', source);
    await run('project', 'remove', 'gone');

    const r = await run('project', 'list');
    expect(r.stdout).not.toContain('gone');
    rmSync(source, { recursive: true, force: true });
  });

  test('add creates a task, tasks shows it', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'taskproj', '--source', source);

    const r1 = await run('add', 'Build the widget');
    expect(r1.exitCode).toBe(0);
    expect(r1.stdout).toMatch(/Added task t-\d+-\d+ \(pending\)/);

    const r2 = await run('tasks');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('Build the widget');
    expect(r2.stdout).toContain('pending');
    rmSync(source, { recursive: true, force: true });
  });

  test('add --depends-on with valid dep works', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'depproj', '--source', source);

    const r1 = await run('add', 'First task');
    const taskId = r1.stdout.match(/t-\d+-\d+/)?.[0];
    expect(taskId).toBeDefined();

    const r2 = await run('add', '--depends-on', taskId!, 'Second task');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain(`[deps: ${taskId}]`);

    const r3 = await run('tasks');
    expect(r3.stdout).toContain('waiting');
    rmSync(source, { recursive: true, force: true });
  });

  test('add --depends-on with invalid dep fails', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'depproj2', '--source', source);

    const r = await run('add', '--depends-on', 't-99999', 'Bad dep task');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain("dependency task 't-99999' not found");
    rmSync(source, { recursive: true, force: true });
  });

  test('unblock changes blocked task to pending', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'ubproj', '--source', source);

    const r1 = await run('add', 'Block me');
    const taskId = r1.stdout.match(/t-\d+-\d+/)?.[0]!;

    await run('set-status', taskId, 'blocked');
    const r2 = await run('unblock', taskId);
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain(`Unblocked task ${taskId}`);

    const r3 = await run('tasks');
    expect(r3.stdout).toContain('pending');
    rmSync(source, { recursive: true, force: true });
  });

  test('backlog and activate change task status', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'blproj', '--source', source);

    const r1 = await run('add', 'Backlog me');
    const taskId = r1.stdout.match(/t-\d+-\d+/)?.[0]!;

    await run('backlog', taskId);
    let r = await run('tasks');
    expect(r.stdout).toContain('backlogged');

    await run('activate', taskId);
    r = await run('tasks');
    expect(r.stdout).toContain('pending');
    rmSync(source, { recursive: true, force: true });
  });

  test('set-status changes task status', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'ssproj', '--source', source);

    const r1 = await run('add', 'Status task');
    const taskId = r1.stdout.match(/t-\d+-\d+/)?.[0]!;

    await run('set-status', taskId, 'completed');
    const r = await run('tasks');
    expect(r.stdout).toContain('completed');
    rmSync(source, { recursive: true, force: true });
  });

  test('status shows overview', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'statproj', '--source', source);
    await run('add', 'Task 1');
    await run('add', 'Task 2');

    const r = await run('status');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Project: statproj');
    expect(r.stdout).toContain('Tasks: 2 total');
    expect(r.stdout).toContain('pending: 2');
    expect(r.stdout).toContain('Agents: 0 total');
    expect(r.stdout).toContain('(no clones — run agent-pool init)');
    rmSync(source, { recursive: true, force: true });
  });

  test('-p flag selects project', async () => {
    const s1 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    const s2 = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'proj-a', '--source', s1);
    await run('project', 'add', 'proj-b', '--source', s2);

    await run('-p', 'proj-b', 'add', 'Task for B');
    const r = await run('-p', 'proj-b', 'tasks');
    expect(r.stdout).toContain('Task for B');

    const r2 = await run('tasks');
    expect(r2.stdout).not.toContain('Task for B');
    rmSync(s1, { recursive: true, force: true });
    rmSync(s2, { recursive: true, force: true });
  });

  test('add --backlog creates backlogged task', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'bkproj', '--source', source);

    const r = await run('add', '--backlog', 'Backlog task');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('(backlogged)');
    rmSync(source, { recursive: true, force: true });
  });

  test('approvals shows no pending message', async () => {
    const r = await run('approvals');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('No pending approval requests.');
  });

  test('approve nonexistent id fails', async () => {
    const r = await run('approve', 'req-nonexistent');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not found');
  });

  test('deny nonexistent id fails', async () => {
    const r = await run('deny', 'req-nonexistent');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('not found');
  });

  test('start with no projects exits with error', async () => {
    const r = await run('start');
    expect(r.exitCode).toBe(1);
    expect(r.stderr).toContain('No projects registered');
  });

  test('init without project fails gracefully', async () => {
    const r = await run('init');
    expect(r.exitCode).not.toBe(0);
  });

  test('init creates clones in the DB', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    // Create a git repo at source
    const { spawnSync } = await import('child_process');
    const { writeFileSync } = await import('fs');
    spawnSync('git', ['init'], { cwd: source });
    spawnSync('git', ['config', 'user.email', 'test@test.com'], { cwd: source });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: source });
    writeFileSync(join(source, 'README.md'), '# Test\n');
    spawnSync('git', ['add', '.'], { cwd: source });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: source });

    await run('project', 'add', 'initproj', '--source', source);
    const r = await run('init', '-n', '2');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Clone 0 created');
    expect(r.stdout).toContain('Clone 1 created');
    expect(r.stdout).toContain('2 clones ready');

    // Status should show 2 clones with per-clone table
    const st = await run('status');
    expect(st.stdout).toContain('Agents: 2 total');
    expect(st.stdout).toContain('Agent     Status');
    expect(st.stdout).toContain('-----     ------');

    // Release a clone
    const rel = await run('release', '0');
    expect(rel.exitCode).toBe(0);
    expect(rel.stdout).toContain('Released clone 0');

    // Destroy all clones
    const d = await run('destroy');
    expect(d.exitCode).toBe(0);
    expect(d.stdout).toContain('Destroyed 2 clones');

    // Status should show 0 agents
    const st2 = await run('status');
    expect(st2.stdout).toContain('Agents: 0 total');

    rmSync(source, { recursive: true, force: true });
  });

  test('docs prints a message', async () => {
    const r = await run('docs');
    expect(r.exitCode).toBe(0);
    expect(r.stdout.length).toBeGreaterThan(0);
  });

  test('docs lists shared and agent directories', async () => {
    const sharedDir = join(dataDir, 'docs', 'shared');
    const agentDir = join(dataDir, 'docs', 'agents', 'agent-01');
    mkdirSync(sharedDir, { recursive: true });
    mkdirSync(agentDir, { recursive: true });
    writeFileSync(join(sharedDir, 'lessons.md'), '# Lessons\nSome content');
    writeFileSync(join(agentDir, 'notes.md'), '# Agent notes\nMore content');

    const r = await run('docs');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('shared');
    expect(r.stdout).toContain('agent-01');
    expect(r.stdout).toContain('Directory');
    expect(r.stdout).toContain('Files');
  });

  test('docs shared prints file contents', async () => {
    const sharedDir = join(dataDir, 'docs', 'shared');
    mkdirSync(sharedDir, { recursive: true });
    writeFileSync(join(sharedDir, 'lessons.md'), '# Lessons\nImportant lesson here');

    const r = await run('docs', 'shared');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Shared docs');
    expect(r.stdout).toContain('lessons.md');
    expect(r.stdout).toContain('Important lesson here');
  });

  test('migrate imports v1 fixture data', async () => {
    createV1Fixtures(dataDir, {
      projectCount: 1,
      tasksPerProject: 2,
      clonesPerProject: 2,
    });

    const r = await run('migrate');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Migration complete');
    expect(r.stdout).toContain('Projects:     1');
    expect(r.stdout).toContain('Tasks:        2');
    expect(r.stdout).toContain('Clones:       2');

    // Verify migrated tasks show up in tasks list
    const r2 = await run('tasks');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('Task 0 for myproject');
    expect(r2.stdout).toContain('Task 1 for myproject');
  });

  test('help shows key command names', async () => {
    const r = await run('help');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('agent-pool');
    expect(r.stdout).toContain('add');
    expect(r.stdout).toContain('tasks');
    expect(r.stdout).toContain('status');
    expect(r.stdout).toContain('project');
    expect(r.stdout).toContain('migrate');
    expect(r.stdout).toContain('docs');
    expect(r.stdout).toContain('init');
    expect(r.stdout).toContain('launch');
    expect(r.stdout).toContain('review');
    expect(r.stdout).toContain('approvals');
  });

  test('review --commits 5 creates a review task', async () => {
    const source = mkdtempSync(join(tmpdir(), 'ap-src-'));
    await run('project', 'add', 'revproj', '--source', source);

    const r = await run('review', '--commits', '5');
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain('Added review task');
    expect(r.stdout).toContain('(pending)');

    // Verify the review task appears in tasks list
    const r2 = await run('tasks');
    expect(r2.exitCode).toBe(0);
    expect(r2.stdout).toContain('pending');
    // The task should contain review-related prompt text
    expect(r2.stdout).toMatch(/t-\d+-\d+/);

    rmSync(source, { recursive: true, force: true });
  });
});
