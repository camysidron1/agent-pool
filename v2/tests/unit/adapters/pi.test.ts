import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, existsSync, readFileSync, lstatSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { PiAdapter } from '../../../src/adapters/pi/index.js';
import { MockGitClient } from '../../../src/git/mock.js';
import { createAdapter, resolveAgentType } from '../../../src/adapters/factory.js';
import type { AgentContext } from '../../../src/adapters/agent.js';
import type { TaskStore, Task, TaskInput, TaskStatus, TaskLog } from '../../../src/stores/interfaces.js';

function makeTmpDir(): string {
  return mkdtempSync(join(tmpdir(), 'pi-adapter-test-'));
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

// Minimal TaskStore mock
const mockTaskStore: TaskStore = {
  add(input: TaskInput): Task {
    return {
      id: 't-new',
      projectName: input.projectName,
      prompt: input.prompt,
      status: 'pending',
      claimedBy: null,
      createdAt: new Date().toISOString(),
      startedAt: null,
      completedAt: null,
      priority: input.priority ?? 0,
      timeoutMinutes: null,
      retryMax: 1,
      retryCount: 0,
      retryStrategy: 'same',
      result: null,
      pipelineId: null,
      pipelineStepId: null,
    };
  },
  getAll: () => [],
  get: () => null,
  claim: () => null,
  mark: () => {},
  updateFields: () => {},
  getDependencies: () => [],
  addDependency: () => {},
  addLog: (log: Omit<TaskLog, 'id' | 'createdAt'>) => ({ ...log, id: 1, createdAt: new Date().toISOString() }),
  getLogs: () => [],
  releaseAgent: () => 0,
  getByPipeline: () => [],
};

describe('PiAdapter', () => {
  let git: MockGitClient;
  let adapter: PiAdapter;
  let dirs: string[];

  beforeEach(() => {
    git = new MockGitClient();
    adapter = new PiAdapter(git, mockTaskStore);
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
      expect(result).toBe('[TRACKING]\nJira stuff\n---\n[WORKFLOW]\nBranch stuff\n---\ndo the task');
    });

    test('returns just prompt when no context', () => {
      const ctx = makeContext({ prompt: 'just this' });
      expect(adapter.buildPrompt(ctx)).toBe('just this');
    });
  });

  describe('setup', () => {
    test('fetches and creates branch', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const fetchCalls = git.calls.filter(c => c.method === 'fetch');
      expect(fetchCalls).toHaveLength(1);

      const branchCalls = git.calls.filter(c => c.method === 'createBranch');
      expect(branchCalls).toHaveLength(1);
      expect(branchCalls[0].args).toEqual([
        ctx.clonePath,
        `${ctx.agentId}-${ctx.taskId}`,
        `origin/${ctx.branch}`,
      ]);
    });

    test('creates agent-docs and shared-docs symlinks', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const agentDocsLink = join(ctx.clonePath, 'agent-docs');
      const sharedDocsLink = join(ctx.clonePath, 'shared-docs');

      expect(existsSync(agentDocsLink)).toBe(true);
      expect(existsSync(sharedDocsLink)).toBe(true);
      expect(lstatSync(agentDocsLink).isSymbolicLink()).toBe(true);
      expect(lstatSync(sharedDocsLink).isSymbolicLink()).toBe(true);
    });

    test('updates .gitignore', async () => {
      const ctx = tracked(makeContext());
      await adapter.setup(ctx);

      const gitignore = readFileSync(join(ctx.clonePath, '.gitignore'), 'utf-8');
      expect(gitignore).toContain('agent-docs');
      expect(gitignore).toContain('shared-docs');
      expect(gitignore).toContain('.pi');
    });
  });

  describe('getLogPath', () => {
    test('returns standard log path', () => {
      const ctx = makeContext();
      const logPath = adapter.getLogPath!(ctx);
      expect(logPath).toBe(join(ctx.dataDir, 'logs', ctx.agentId, `${ctx.taskId}.log`));
    });
  });
});

describe('Factory — pi type', () => {
  test('resolveAgentType accepts pi', () => {
    expect(resolveAgentType('pi')).toBe('pi');
  });

  test('createAdapter creates PiAdapter with taskStore', () => {
    const git = new MockGitClient();
    const adapter = createAdapter('pi', git, { taskStore: mockTaskStore });
    expect(adapter).toBeInstanceOf(PiAdapter);
  });

  test('createAdapter throws without taskStore for pi', () => {
    const git = new MockGitClient();
    expect(() => createAdapter('pi', git)).toThrow('taskStore');
  });

  test('createAdapter still works for claude without deps', () => {
    const git = new MockGitClient();
    // Should not throw
    const adapter = createAdapter('claude', git);
    expect(adapter).toBeTruthy();
  });
});
