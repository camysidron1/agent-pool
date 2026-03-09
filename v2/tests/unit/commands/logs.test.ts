import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';
import { registerLogsCommand } from '../../../src/commands/logs.js';
import { Command } from 'commander';

describe('logs command', () => {
  let ctx: TestContext;
  let program: Command;
  let output: string[];

  beforeEach(() => {
    ctx = createTestContext();
    program = new Command();
    program.exitOverride(); // Prevent process.exit
    registerLogsCommand(program, ctx);
    output = [];
    // Capture console.log output
    const origLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
    // Store original to restore later
    (ctx as any)._origConsoleLog = origLog;
  });

  afterEach(() => {
    console.log = (ctx as any)._origConsoleLog;
    ctx.cleanup();
  });

  function addProjectAndTask(): string {
    ctx.stores.projects.add({ name: 'proj', source: '/tmp', prefix: 'p', branch: 'main' });
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'test' });
    return task.id;
  }

  test('shows "No logs found." when no logs exist', async () => {
    await program.parseAsync(['node', 'test', 'logs']);
    expect(output).toContain('No logs found.');
  });

  test('filters logs by taskId', async () => {
    const t1 = addProjectAndTask();
    const t2Id = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'other' }).id;

    ctx.stores.tasks.addLog({ taskId: t1, agentId: 'agent-01', logPath: '/a.log', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 0 });
    ctx.stores.tasks.addLog({ taskId: t2Id, agentId: 'agent-02', logPath: '/b.log', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 0 });

    await program.parseAsync(['node', 'test', 'logs', t1]);

    expect(output).toHaveLength(1);
    expect(output[0]).toContain(t1);
    expect(output[0]).not.toContain(t2Id);
  });

  test('filters logs by agent', async () => {
    const t1 = addProjectAndTask();

    ctx.stores.tasks.addLog({ taskId: t1, agentId: 'agent-01', logPath: '/a.log', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 0 });
    ctx.stores.tasks.addLog({ taskId: t1, agentId: 'agent-02', logPath: '/b.log', startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 1 });

    await program.parseAsync(['node', 'test', 'logs', '--agent', 'agent-01']);

    expect(output).toHaveLength(1);
    expect(output[0]).toContain('agent-01');
  });

  test('respects --last flag', async () => {
    const t1 = addProjectAndTask();

    for (let i = 0; i < 5; i++) {
      ctx.stores.tasks.addLog({ taskId: t1, agentId: 'agent-01', logPath: `/log-${i}.log`, startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 0 });
    }

    await program.parseAsync(['node', 'test', 'logs', '--last', '2']);

    expect(output).toHaveLength(2);
  });

  test('defaults to last 20 when no filters', async () => {
    const t1 = addProjectAndTask();

    for (let i = 0; i < 25; i++) {
      ctx.stores.tasks.addLog({ taskId: t1, agentId: 'agent-01', logPath: `/log-${i}.log`, startedAt: '2025-01-01T00:00:00Z', completedAt: '2025-01-01T00:05:00Z', exitCode: 0 });
    }

    await program.parseAsync(['node', 'test', 'logs']);

    expect(output).toHaveLength(20);
  });

  test('displays exit code and duration', async () => {
    const t1 = addProjectAndTask();

    ctx.stores.tasks.addLog({
      taskId: t1,
      agentId: 'agent-01',
      logPath: '/tmp/test.log',
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: '2025-01-01T00:05:00Z',
      exitCode: 0,
    });

    await program.parseAsync(['node', 'test', 'logs', t1]);

    expect(output[0]).toContain('exit=0');
    expect(output[0]).toContain('5m0s');
    expect(output[0]).toContain('/tmp/test.log');
  });

  test('displays "running" for null exit code', async () => {
    const t1 = addProjectAndTask();

    ctx.stores.tasks.addLog({
      taskId: t1,
      agentId: 'agent-01',
      logPath: '/tmp/test.log',
      startedAt: '2025-01-01T00:00:00Z',
      completedAt: null,
      exitCode: null,
    });

    await program.parseAsync(['node', 'test', 'logs', t1]);

    expect(output[0]).toContain('running');
    expect(output[0]).toContain('in progress');
  });
});
