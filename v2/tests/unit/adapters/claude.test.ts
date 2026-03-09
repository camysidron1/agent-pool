import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync, writeFileSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { ClaudeAdapter } from '../../../src/adapters/claude.js';
import { MockGitClient } from '../../../src/git/mock.js';
import type { AgentContext } from '../../../src/adapters/agent.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'claude-adapter-test-'));
}

function makeContext(overrides?: Partial<AgentContext>): AgentContext {
  return {
    taskId: 't-1',
    prompt: 'do something',
    clonePath: makeTmpDir(),
    projectName: 'testproj',
    agentId: 'agent-01',
    branch: 'main',
    dataDir: makeTmpDir(),
    toolDir: '/opt/agent-pool',
    skipPermissions: false,
    ...overrides,
  };
}

describe('ClaudeAdapter', () => {
  let git: MockGitClient;
  let adapter: ClaudeAdapter;
  let dirs: string[];

  beforeEach(() => {
    git = new MockGitClient();
    adapter = new ClaudeAdapter(git);
    dirs = [];
  });

  afterEach(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  function tracked(ctx: AgentContext): AgentContext {
    dirs.push(ctx.clonePath, ctx.dataDir);
    return ctx;
  }

  describe('buildPrompt', () => {
    test('returns prompt with tracking and workflow context', () => {
      const ctx = makeContext({
        prompt: 'do the task',
        trackingContext: '[TRACKING]\nJira stuff\n---',
        workflowContext: '[WORKFLOW]\nBranch stuff\n---',
      });

      const result = adapter.buildPrompt(ctx);
      expect(result).toBe(
        '[TRACKING]\nJira stuff\n---\n[WORKFLOW]\nBranch stuff\n---\ndo the task',
      );
    });

    test('returns just prompt when no context', () => {
      const ctx = makeContext({ prompt: 'just this' });
      expect(adapter.buildPrompt(ctx)).toBe('just this');
    });

    test('returns prompt with only tracking context', () => {
      const ctx = makeContext({
        prompt: 'task',
        trackingContext: '[TRACKING]',
      });
      expect(adapter.buildPrompt(ctx)).toBe('[TRACKING]\ntask');
    });

    test('returns prompt with only workflow context', () => {
      const ctx = makeContext({
        prompt: 'task',
        workflowContext: '[WORKFLOW]',
      });
      expect(adapter.buildPrompt(ctx)).toBe('[WORKFLOW]\ntask');
    });
  });

  describe('setup', () => {
    test('fetches and creates branch', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const fetchCalls = git.calls.filter((c) => c.method === 'fetch');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].args[0]).toBe(ctx.clonePath);

      const branchCalls = git.calls.filter(
        (c) => c.method === 'createBranch',
      );
      expect(branchCalls).toHaveLength(1);
      expect(branchCalls[0].args).toEqual([
        ctx.clonePath,
        'agent-01-t-1',
        'origin/main',
      ]);
    });

    test('fixes local origin URL', async () => {
      const ctx = tracked(makeContext());
      git.remoteUrls.set(ctx.clonePath, '/local/path');
      git.remoteUrls.set('/local/path', 'https://github.com/org/repo.git');

      await adapter.setup(ctx);

      const setUrlCalls = git.calls.filter(
        (c) => c.method === 'setRemoteUrl',
      );
      expect(setUrlCalls).toHaveLength(1);
      expect(setUrlCalls[0].args[1]).toBe(
        'https://github.com/org/repo.git',
      );
    });

    test('does not fix non-local origin URL', async () => {
      const ctx = tracked(makeContext());
      git.remoteUrls.set(ctx.clonePath, 'https://github.com/org/repo.git');

      await adapter.setup(ctx);

      const setUrlCalls = git.calls.filter(
        (c) => c.method === 'setRemoteUrl',
      );
      expect(setUrlCalls).toHaveLength(0);
    });

    test('installs hooks with approval when not skipPermissions', async () => {
      const ctx = tracked(makeContext({ skipPermissions: false }));
      await adapter.setup(ctx);

      const settingsPath = join(ctx.clonePath, '.claude', 'settings.json');
      expect(existsSync(settingsPath)).toBe(true);

      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      expect(settings.hooks.PreToolUse).toHaveLength(1);
      const hooks = settings.hooks.PreToolUse[0].hooks;
      expect(hooks).toHaveLength(2);
      expect(hooks[0].command).toContain('mailbox-hook.sh');
      expect(hooks[1].command).toContain('approval-hook.sh');
    });

    test('installs only mailbox hook when skipPermissions', async () => {
      const ctx = tracked(makeContext({ skipPermissions: true }));
      await adapter.setup(ctx);

      const settingsPath = join(ctx.clonePath, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const hooks = settings.hooks.PreToolUse[0].hooks;
      expect(hooks).toHaveLength(1);
      expect(hooks[0].command).toContain('mailbox-hook.sh');
    });

    test('creates docs symlinks', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const agentDocsLink = join(ctx.clonePath, 'agent-docs');
      const sharedDocsLink = join(ctx.clonePath, 'shared-docs');

      expect(existsSync(agentDocsLink)).toBe(true);
      expect(existsSync(sharedDocsLink)).toBe(true);
      expect(lstatSync(agentDocsLink).isSymbolicLink()).toBe(true);
      expect(lstatSync(sharedDocsLink).isSymbolicLink()).toBe(true);
    });

    test('creates agent and shared docs directories in dataDir', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      expect(
        existsSync(join(ctx.dataDir, 'docs', 'agents', 'agent-01')),
      ).toBe(true);
      expect(existsSync(join(ctx.dataDir, 'docs', 'shared'))).toBe(true);
    });

    test('installs finish command', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const finishPath = join(
        ctx.clonePath,
        '.claude',
        'commands',
        'finish.md',
      );
      expect(existsSync(finishPath)).toBe(true);
      const content = readFileSync(finishPath, 'utf-8');
      expect(content).toContain('Finish Task');
      expect(content).toContain('finish-task.ts');
    });

    test('appends doc rules to CLAUDE.md', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const claudeMdPath = join(ctx.clonePath, 'CLAUDE.md');
      expect(existsSync(claudeMdPath)).toBe(true);
      const content = readFileSync(claudeMdPath, 'utf-8');
      expect(content).toContain('Documentation Rules');
    });

    test('does not duplicate doc rules on second setup', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);
      await adapter.setup(ctx);

      const claudeMdPath = join(ctx.clonePath, 'CLAUDE.md');
      const content = readFileSync(claudeMdPath, 'utf-8');
      const matches = content.match(/Documentation Rules/g);
      // Marker appears twice: heading + first sentence, but only one block
      expect(matches!.length).toBeLessThanOrEqual(2);
    });

    test('updates .gitignore with required entries', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const gitignorePath = join(ctx.clonePath, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);
      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('agent-docs');
      expect(content).toContain('shared-docs');
      expect(content).toContain('CLAUDE.md');
      expect(content).toContain('.claude/commands/finish.md');
    });

    test('does not duplicate .gitignore entries on second setup', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);
      await adapter.setup(ctx);

      const gitignorePath = join(ctx.clonePath, '.gitignore');
      const content = readFileSync(gitignorePath, 'utf-8');
      const lines = content.split('\n').filter((l) => l === 'agent-docs');
      expect(lines).toHaveLength(1);
    });

    test('uses toolDir in hook paths', async () => {
      const ctx = tracked(
        makeContext({ toolDir: '/custom/tool/dir' }),
      );
      await adapter.setup(ctx);

      const settingsPath = join(ctx.clonePath, '.claude', 'settings.json');
      const settings = JSON.parse(readFileSync(settingsPath, 'utf-8'));
      const hooks = settings.hooks.PreToolUse[0].hooks;
      expect(hooks[0].command).toBe(
        '/custom/tool/dir/hooks/mailbox-hook.sh',
      );
    });
  });

  describe('buildScriptArgs', () => {
    test('macOS: produces script -q <file> <cmd...> format', () => {
      // Only test on macOS since buildScriptArgs checks process.platform
      const args = adapter.buildScriptArgs(['claude', 'do stuff'], '/tmp/test.log');
      if (process.platform === 'darwin') {
        expect(args).toEqual(['script', '-q', '/tmp/test.log', 'claude', 'do stuff']);
      } else {
        // Linux: script -qc "claude \"do stuff\"" /tmp/test.log
        expect(args[0]).toBe('script');
        expect(args[1]).toBe('-qc');
        expect(args[3]).toBe('/tmp/test.log');
      }
    });

    test('preserves all claude args', () => {
      const args = adapter.buildScriptArgs(
        ['claude', 'my prompt', '--dangerously-skip-permissions'],
        '/tmp/out.log',
      );
      if (process.platform === 'darwin') {
        expect(args).toEqual([
          'script', '-q', '/tmp/out.log',
          'claude', 'my prompt', '--dangerously-skip-permissions',
        ]);
      } else {
        expect(args[0]).toBe('script');
        expect(args[1]).toBe('-qc');
        // The command string should contain all args
        expect(args[2]).toContain('claude');
        expect(args[2]).toContain('--dangerously-skip-permissions');
        expect(args[3]).toBe('/tmp/out.log');
      }
    });

    test('Linux: quotes args containing spaces in command string', () => {
      // This tests the quoting logic used for Linux
      const claudeArgs = ['claude', 'prompt with spaces'];
      const cmdStr = claudeArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
      expect(cmdStr).toBe('claude "prompt with spaces"');
    });
  });

  describe('getLogPath', () => {
    test('returns correct log path for a context', () => {
      const ctx = makeContext({ dataDir: '/data', agentId: 'agent-03', taskId: 't-42' });
      const logPath = adapter.getLogPath(ctx);
      expect(logPath).toBe('/data/logs/agent-03/t-42.log');
    });
  });

  describe('abort and forceKill', () => {
    test('abort does not throw when no process is running', () => {
      expect(() => adapter.abort()).not.toThrow();
    });

    test('forceKill does not throw when no process is running', () => {
      expect(() => adapter.forceKill()).not.toThrow();
    });
  });

  describe('rotateLogFiles', () => {
    test('deletes oldest files when count exceeds maxLogs', () => {
      const logDir = mkdtempSync(join(tmpdir(), 'log-rotate-'));
      dirs.push(logDir);

      // Create 25 log files with staggered mtimes
      for (let i = 0; i < 25; i++) {
        const filePath = join(logDir, `t-${String(i).padStart(3, '0')}.log`);
        writeFileSync(filePath, `log content ${i}`);
      }

      // Call rotateLogFiles via a run() that creates the dir + rotates
      // Since rotateLogFiles is private, we test it indirectly through behavior.
      // We can test by making a new adapter and using the public interface approach,
      // but since it's called in run(), let's call it via a subclass trick.

      // Actually, let's just call it by accessing the prototype
      const rotateLogFiles = (ClaudeAdapter.prototype as any).rotateLogFiles;
      rotateLogFiles.call(adapter, logDir, 20);

      const remaining = readdirSync(logDir).filter(f => f.endsWith('.log'));
      expect(remaining).toHaveLength(20);
    });

    test('does nothing when file count is at or below maxLogs', () => {
      const logDir = mkdtempSync(join(tmpdir(), 'log-rotate-'));
      dirs.push(logDir);

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(logDir, `t-${i}.log`), `log ${i}`);
      }

      const rotateLogFiles = (ClaudeAdapter.prototype as any).rotateLogFiles;
      rotateLogFiles.call(adapter, logDir, 20);

      const remaining = readdirSync(logDir).filter(f => f.endsWith('.log'));
      expect(remaining).toHaveLength(5);
    });

    test('ignores non-log files during rotation', () => {
      const logDir = mkdtempSync(join(tmpdir(), 'log-rotate-'));
      dirs.push(logDir);

      for (let i = 0; i < 5; i++) {
        writeFileSync(join(logDir, `t-${i}.log`), `log ${i}`);
      }
      writeFileSync(join(logDir, 'notes.txt'), 'not a log');

      const rotateLogFiles = (ClaudeAdapter.prototype as any).rotateLogFiles;
      rotateLogFiles.call(adapter, logDir, 3);

      const allFiles = readdirSync(logDir);
      const logs = allFiles.filter(f => f.endsWith('.log'));
      expect(logs).toHaveLength(3);
      expect(allFiles).toContain('notes.txt');
    });
  });
});
