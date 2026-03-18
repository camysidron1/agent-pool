import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { CodexAdapter } from '../../../src/adapters/codex.js';
import { MockGitClient } from '../../../src/git/mock.js';
import type { AgentContext } from '../../../src/adapters/agent.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'codex-adapter-test-'));
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

describe('CodexAdapter', () => {
  let git: MockGitClient;
  let adapter: CodexAdapter;
  let dirs: string[];

  beforeEach(() => {
    git = new MockGitClient();
    adapter = new CodexAdapter(git);
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

  describe('setup', () => {
    test('calls checkoutTaskBranch (fetch + createBranch)', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const fetchCalls = git.calls.filter((c) => c.method === 'fetch');
      expect(fetchCalls).toHaveLength(1);
      expect(fetchCalls[0].args[0]).toBe(ctx.clonePath);

      const branchCalls = git.calls.filter((c) => c.method === 'createBranch');
      expect(branchCalls).toHaveLength(1);
      expect(branchCalls[0].args).toEqual([
        ctx.clonePath,
        'agent-01-t-1',
        'origin/main',
      ]);
    });

    test('calls setupDocs (creates symlinks)', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const agentDocsLink = join(ctx.clonePath, 'agent-docs');
      const sharedDocsLink = join(ctx.clonePath, 'shared-docs');

      expect(existsSync(agentDocsLink)).toBe(true);
      expect(existsSync(sharedDocsLink)).toBe(true);
      expect(lstatSync(agentDocsLink).isSymbolicLink()).toBe(true);
      expect(lstatSync(sharedDocsLink).isSymbolicLink()).toBe(true);
    });

    test('writes AGENTS.md with doc rules and finish instructions', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const agentsMdPath = join(ctx.clonePath, 'AGENTS.md');
      expect(existsSync(agentsMdPath)).toBe(true);
      const content = readFileSync(agentsMdPath, 'utf-8');
      expect(content).toContain('Documentation Rules');
      expect(content).toContain('finish-task.ts');
      expect(content).toContain('gh pr create');
    });

    test('updates .gitignore with correct entries', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const gitignorePath = join(ctx.clonePath, '.gitignore');
      expect(existsSync(gitignorePath)).toBe(true);
      const content = readFileSync(gitignorePath, 'utf-8');
      expect(content).toContain('agent-docs');
      expect(content).toContain('shared-docs');
      expect(content).toContain('AGENTS.md');
    });

    test('fixes local origin URL', async () => {
      const ctx = tracked(makeContext());
      git.remoteUrls.set(ctx.clonePath, '/local/path');
      git.remoteUrls.set('/local/path', 'https://github.com/org/repo.git');

      await adapter.setup(ctx);

      const setUrlCalls = git.calls.filter((c) => c.method === 'setRemoteUrl');
      expect(setUrlCalls).toHaveLength(1);
      expect(setUrlCalls[0].args[1]).toBe('https://github.com/org/repo.git');
    });
  });

  describe('buildPrompt', () => {
    test('prepends tracking and workflow context', () => {
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
  });

  describe('getLogPath', () => {
    test('returns correct log path', () => {
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
});
