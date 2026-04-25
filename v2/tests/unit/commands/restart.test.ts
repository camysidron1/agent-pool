import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { Command } from 'commander';
import { createTestContext, type TestContext } from '../../fixtures/context.js';
import { registerRestartCommand } from '../../../src/commands/restart.js';
import { MockCmuxClient } from '../../../src/cmux/mock.js';
import { MockGitClient } from '../../../src/git/mock.js';

describe('restart command', () => {
  let ctx: TestContext;
  let program: Command;
  let output: string[];
  let origLog: typeof console.log;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.stores.projects.add({ name: 'proj', source: '/tmp/src', prefix: 'p', branch: 'main' });
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.lock('proj', 0, 'surface:old-pane');

    program = new Command();
    program.exitOverride();
    program.option('-p, --project <name>', 'project name');
    registerRestartCommand(program, ctx);

    output = [];
    origLog = console.log;
    console.log = (...args: unknown[]) => {
      output.push(args.map(String).join(' '));
    };
  });

  afterEach(() => {
    console.log = origLog;
    ctx.cleanup();
  });

  test('soft restart reuses the existing pane', async () => {
    await program.parseAsync(['node', 'test', '-p', 'proj', 'restart', '0', '--no-push']);

    const cmux = ctx.cmux as unknown as MockCmuxClient;
    const methods = cmux.calls.map(c => c.method);
    expect(methods).toContain('sendKeys');
    expect(methods).toContain('send');
    expect(methods).not.toContain('closeSurface');
    expect(methods).not.toContain('newSplit');

    expect(output.some(line => line.includes('Restarted clone 0 in existing pane'))).toBe(true);
  });

  test('hard restart closes the old surface and launches a fresh split', async () => {
    await program.parseAsync(['node', 'test', '-p', 'proj', 'restart', '0', '--hard', '--no-push']);

    const cmux = ctx.cmux as unknown as MockCmuxClient;
    const methods = cmux.calls.map(c => c.method);
    expect(methods).toContain('closeSurface');
    expect(methods).toContain('newSplit');
    expect(methods).toContain('send');

    const closeIdx = methods.indexOf('closeSurface');
    const splitIdx = methods.indexOf('newSplit');
    expect(closeIdx).toBeGreaterThanOrEqual(0);
    expect(splitIdx).toBeGreaterThan(closeIdx);

    const closeCall = cmux.calls.find(c => c.method === 'closeSurface');
    expect(closeCall?.args[0]).toBe('old-pane');

    const clone = ctx.stores.clones.get('proj', 0);
    expect(clone?.workspaceId.startsWith('surface:')).toBe(true);
    expect(clone?.workspaceId).not.toBe('surface:old-pane');

    const git = ctx.git as unknown as MockGitClient;
    expect(git.calls.map(c => c.method)).toEqual([
      'fetch',
      'checkout',
      'resetHard',
      'clean',
      'deleteBranches',
    ]);

    expect(output.some(line => line.includes('Hard restarted clone 0 in fresh pane'))).toBe(true);
  });

  test('hard restart without index rebuilds all agents in a 2x2 grid', async () => {
    // Add 3 more locked clones.
    ctx.stores.clones.add('proj', 1, 'main');
    ctx.stores.clones.lock('proj', 1, 'surface:old-pane-1');
    ctx.stores.clones.add('proj', 2, 'main');
    ctx.stores.clones.lock('proj', 2, 'surface:old-pane-2');
    ctx.stores.clones.add('proj', 3, 'main');
    ctx.stores.clones.lock('proj', 3, 'surface:old-pane-3');

    await program.parseAsync(['node', 'test', '-p', 'proj', 'restart', '--hard', '--no-push']);

    const cmux = ctx.cmux as unknown as MockCmuxClient;
    const splitCalls = cmux.calls.filter(c => c.method === 'newSplit');
    expect(splitCalls.length).toBe(4);
    expect(splitCalls[0].args[0]).toBe('right');
    expect(splitCalls[1].args[0]).toBe('right');
    expect(splitCalls[2].args[0]).toBe('down');
    expect(splitCalls[3].args[0]).toBe('down');

    // All clones should now point at fresh surface refs.
    for (let i = 0; i < 4; i++) {
      const clone = ctx.stores.clones.get('proj', i);
      expect(clone?.workspaceId.startsWith('surface:surface:s-')).toBe(true);
    }

    // One refresh cycle per clone.
    const git = ctx.git as unknown as MockGitClient;
    expect(git.calls.filter(c => c.method === 'fetch').length).toBe(4);

    expect(output.filter(line => line.includes('Hard restarted clone')).length).toBe(4);
  });
});
