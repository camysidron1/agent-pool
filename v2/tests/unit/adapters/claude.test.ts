import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync } from 'fs';
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
});
