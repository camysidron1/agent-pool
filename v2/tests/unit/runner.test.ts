import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { createTestContext, type TestContext } from '../fixtures/context.js';
import { AgentRunner, type RunnerOptions } from '../../src/runner/runner.js';
import type { AgentAdapter, AgentContext } from '../../src/adapters/agent.js';
import type { Project } from '../../src/stores/interfaces.js';

class MockAgentAdapter implements AgentAdapter {
  setupCalls: AgentContext[] = [];
  runCalls: AgentContext[] = [];
  exitCode = 0;
  abortCalls = 0;
  forceKillCalls = 0;
  private _runResolve: (() => void) | null = null;

  async setup(ctx: AgentContext) {
    this.setupCalls.push(ctx);
  }
  async run(ctx: AgentContext) {
    this.runCalls.push(ctx);
    return this.exitCode;
  }
  buildPrompt(ctx: AgentContext) {
    return ctx.prompt;
  }
  abort() {
    this.abortCalls++;
    // Resolve the hanging run if one exists
    if (this._runResolve) this._runResolve();
  }
  forceKill() {
    this.forceKillCalls++;
    if (this._runResolve) this._runResolve();
  }
  getLogPath(ctx: AgentContext) {
    return `/tmp/logs/${ctx.taskId}.log`;
  }

  /** Make run() hang until abort/forceKill is called. Returns exit code 1 when resolved. */
  hangUntilAborted(): void {
    this.run = async (ctx: AgentContext) => {
      this.runCalls.push(ctx);
      return new Promise<number>((resolve) => {
        this._runResolve = () => resolve(1);
      });
    };
  }
}

function makeRunner(
  ctx: TestContext,
  adapter: MockAgentAdapter,
  opts?: Partial<RunnerOptions>,
): AgentRunner {
  return new AgentRunner(ctx, adapter, {
    cloneIndex: 1,
    skipPermissions: false,
    pollInterval: 10, // fast for tests
    nonInteractive: true, // default for tests to avoid stdin hangs
    ...opts,
  });
}

function addProject(ctx: TestContext, name = 'myproj'): void {
  ctx.stores.projects.add({
    name,
    source: '/tmp/source',
    prefix: 'mp',
    branch: 'main',
  });
  ctx.stores.projects.setDefault(name);
}

describe('AgentRunner', () => {
  let ctx: TestContext;
  let adapter: MockAgentAdapter;

  beforeEach(() => {
    ctx = createTestContext();
    adapter = new MockAgentAdapter();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  test('agentId is derived from cloneIndex with zero-padding', () => {
    const runner = makeRunner(ctx, adapter, { cloneIndex: 3 });
    expect(runner.getAgentId()).toBe('agent-03');
  });

  test('agentId pads single digit', () => {
    const runner = makeRunner(ctx, adapter, { cloneIndex: 0 });
    expect(runner.getAgentId()).toBe('agent-00');
  });

  test('claims task, calls setup and run, marks completed on exit 0', async () => {
    addProject(ctx);
    const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'do the thing' });

    const runner = makeRunner(ctx, adapter);

    // Stop after first task
    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    expect(adapter.setupCalls).toHaveLength(1);
    expect(adapter.runCalls).toHaveLength(1);
    expect(adapter.setupCalls[0].taskId).toBe(added.id);
    expect(adapter.setupCalls[0].prompt).toBe('do the thing');
    expect(adapter.setupCalls[0].projectName).toBe('myproj');
    expect(adapter.setupCalls[0].branch).toBe('main');
    expect(adapter.setupCalls[0].agentId).toBe('agent-01');

    // Task should be completed
    const task = ctx.stores.tasks.get(added.id);
    expect(task!.status).toBe('completed');
  });

  test('marks task blocked on non-zero exit code', async () => {
    addProject(ctx);
    const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'fail me' });

    const runner = makeRunner(ctx, adapter);

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 1;
    };

    await runner.start();

    const task = ctx.stores.tasks.get(added.id);
    expect(task!.status).toBe('blocked');
  });

  test('keeps polling when no tasks, stops on stop()', async () => {
    addProject(ctx);

    const runner = makeRunner(ctx, adapter, { pollInterval: 5 });

    // Stop after a short delay
    setTimeout(() => runner.stop(), 30);
    await runner.start();

    // No tasks should have been claimed
    expect(adapter.setupCalls).toHaveLength(0);
    expect(adapter.runCalls).toHaveLength(0);
  });

  test('resolves project by name', async () => {
    addProject(ctx, 'proj-a');

    ctx.stores.tasks.add({ projectName: 'proj-a', prompt: 'task' });

    const runner = makeRunner(ctx, adapter, { projectName: 'proj-a' });

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    expect(adapter.setupCalls[0].projectName).toBe('proj-a');
  });

  test('throws if project not found', () => {
    expect(() =>
      makeRunner(ctx, adapter, { projectName: 'nope' }).start(),
    ).toThrow("Project 'nope' not found");
  });

  test('throws if no default project', () => {
    expect(() => makeRunner(ctx, adapter).start()).toThrow(
      'No default project set',
    );
  });

  test('passes skipPermissions and envName in agent context', async () => {
    addProject(ctx);
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'x' });

    const runner = makeRunner(ctx, adapter, {
      skipPermissions: true,
      envName: 'staging',
    });

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    expect(adapter.setupCalls[0].skipPermissions).toBe(true);
    expect(adapter.setupCalls[0].envName).toBe('staging');
  });

  test('clone path uses project prefix and padded index', async () => {
    addProject(ctx);
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'x' });

    const runner = makeRunner(ctx, adapter, { cloneIndex: 5 });

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    expect(adapter.setupCalls[0].clonePath).toBe(`${ctx.config.dataDir}/mp-05`);
  });

  test('resets clone after task completion', async () => {
    addProject(ctx);
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'x' });

    const runner = makeRunner(ctx, adapter);
    const gitMock = ctx.git as import('../../src/git/mock.js').MockGitClient;

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    // git.fetch, git.checkout, git.resetHard should have been called for reset
    const fetchCalls = gitMock.calls.filter((c) => c.method === 'fetch');
    const checkoutCalls = gitMock.calls.filter(
      (c) => c.method === 'checkout',
    );
    const resetCalls = gitMock.calls.filter((c) => c.method === 'resetHard');

    expect(fetchCalls.length).toBeGreaterThanOrEqual(1);
    expect(checkoutCalls.length).toBeGreaterThanOrEqual(1);
    expect(resetCalls.length).toBeGreaterThanOrEqual(1);
  });

  describe('buildTrackingContext', () => {
    test('returns NONE context when no tracking configured', () => {
      addProject(ctx);
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildTrackingContext(project);
      expect(result).toContain('[PROJECT TRACKING — NONE]');
      expect(result).toContain('does NOT use issue tracking');
    });

    test('returns tracking context with type and key', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        trackingType: 'jira',
        trackingProjectKey: 'PROJ',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildTrackingContext(project)!;
      expect(result).toContain('[PROJECT TRACKING — JIRA]');
      expect(result).toContain('project: PROJ');
      expect(result).toContain('PROJ-123');
    });

    test('includes label when set', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        trackingType: 'linear',
        trackingProjectKey: 'LIN',
        trackingLabel: 'backend',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildTrackingContext(project)!;
      expect(result).toContain('label: backend');
    });

    test('includes custom instructions when set', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        trackingType: 'jira',
        trackingProjectKey: 'X',
        trackingInstructions: 'Always assign to team-lead',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildTrackingContext(project)!;
      expect(result).toContain('Always assign to team-lead');
    });
  });

  describe('buildWorkflowContext', () => {
    test('returns default workflow when no workflow configured', () => {
      addProject(ctx);
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project);
      expect(result).toContain('[GIT WORKFLOW]');
      expect(result).toContain('Commit your changes');
    });

    test('returns workflow context with type', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        workflowType: 'feature-branch',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project)!;
      expect(result).toContain('[GIT WORKFLOW — FEATURE-BRANCH]');
    });

    test('includes auto-merge for feature-branch by default', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        workflowType: 'feature-branch',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project)!;
      expect(result).toContain('gh pr merge --auto --squash');
    });

    test('uses custom merge method', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        workflowType: 'feature-branch',
        workflowMergeMethod: 'rebase',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project)!;
      expect(result).toContain('--rebase');
    });

    test('includes custom instructions', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        workflowType: 'trunk-based',
        workflowInstructions: 'Push directly to main',
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project)!;
      expect(result).toContain('Push directly to main');
    });

    test('no auto-merge when autoMerge is false', () => {
      addProject(ctx);
      ctx.stores.projects.update('myproj', {
        workflowType: 'feature-branch',
        workflowAutoMerge: false,
      });
      const project = ctx.stores.projects.get('myproj')!;
      const runner = makeRunner(ctx, adapter);

      const result = runner.buildWorkflowContext(project)!;
      expect(result).not.toContain('gh pr merge');
    });
  });

  describe('generatePaneTitle', () => {
    test('uses task id and first line of prompt', () => {
      const runner = makeRunner(ctx, adapter);
      const title = runner.generatePaneTitle({
        id: 't-5',
        projectName: 'proj',
        prompt: 'Fix the bug\nMore details here',
        status: 'pending',
        claimedBy: null,
        createdAt: '',
        startedAt: null,
        completedAt: null,
        priority: 0,
        timeoutMinutes: null,
        retryMax: 1,
        retryCount: 0,
        retryStrategy: 'same',
        result: null,
      });
      expect(title).toBe('t-5: Fix the bug');
    });

    test('truncates long first lines', () => {
      const runner = makeRunner(ctx, adapter);
      const longPrompt = 'A'.repeat(50);
      const title = runner.generatePaneTitle({
        id: 't-1',
        projectName: 'proj',
        prompt: longPrompt,
        status: 'pending',
        claimedBy: null,
        createdAt: '',
        startedAt: null,
        completedAt: null,
        priority: 0,
        timeoutMinutes: null,
        retryMax: 1,
        retryCount: 0,
        retryStrategy: 'same',
        result: null,
      });
      expect(title).toBe(`t-1: ${'A'.repeat(40)}...`);
    });

    test('does not truncate short prompts', () => {
      const runner = makeRunner(ctx, adapter);
      const title = runner.generatePaneTitle({
        id: 't-2',
        projectName: 'proj',
        prompt: 'Short',
        status: 'pending',
        claimedBy: null,
        createdAt: '',
        startedAt: null,
        completedAt: null,
        priority: 0,
        timeoutMinutes: null,
        retryMax: 1,
        retryCount: 0,
        retryStrategy: 'same',
        result: null,
      });
      expect(title).toBe('t-2: Short');
    });
  });

  test('includes tracking and workflow context in agent context', async () => {
    addProject(ctx);
    ctx.stores.projects.update('myproj', {
      trackingType: 'jira',
      trackingProjectKey: 'PROJ',
      workflowType: 'feature-branch',
    });
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'task text' });

    const runner = makeRunner(ctx, adapter);

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    const agentCtx = adapter.setupCalls[0];
    expect(agentCtx.trackingContext).toContain('JIRA');
    expect(agentCtx.workflowContext).toContain('FEATURE-BRANCH');
  });

  test('cleanup unlocks clone on normal exit', async () => {
    addProject(ctx);
    // Lock the clone to simulate the runner holding it
    ctx.stores.clones.add('myproj', 1, 'main');
    ctx.stores.clones.lock('myproj', 1, 'workspace:test');

    const runner = makeRunner(ctx, adapter);

    // Add a task so the runner does work, then stop
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'cleanup test' });
    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    await runner.start();

    // Clone should be unlocked after runner exits
    const clone = ctx.stores.clones.get('myproj', 1);
    expect(clone).not.toBeNull();
    expect(clone!.locked).toBe(false);
  });

  test('cleanup is safe to call without a resolved project', () => {
    const runner = makeRunner(ctx, adapter);
    // Should not throw even though start() was never called
    expect(() => runner.cleanup()).not.toThrow();
  });

  test('cleanup unlocks clone when called directly', () => {
    addProject(ctx);
    ctx.stores.clones.add('myproj', 1, 'main');
    ctx.stores.clones.lock('myproj', 1, 'workspace:test');

    const runner = makeRunner(ctx, adapter, { projectName: 'myproj' });

    // Simulate what start() does: resolve project sets projectName
    // We need to call start and stop quickly to set projectName
    ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'x' });
    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      runner.stop();
      return 0;
    };

    return runner.start().then(() => {
      // Re-lock to test cleanup independently
      ctx.stores.clones.lock('myproj', 1, 'workspace:test2');
      runner.cleanup();
      const clone = ctx.stores.clones.get('myproj', 1);
      expect(clone!.locked).toBe(false);
    });
  });

  test('processes multiple tasks sequentially', async () => {
    addProject(ctx);
    const t1 = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'first' });
    const t2 = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'second' });

    let taskCount = 0;
    const runner = makeRunner(ctx, adapter);

    adapter.run = async (agentCtx: AgentContext) => {
      adapter.runCalls.push(agentCtx);
      taskCount++;
      if (taskCount >= 2) runner.stop();
      return 0;
    };

    await runner.start();

    expect(adapter.setupCalls).toHaveLength(2);
    expect(adapter.setupCalls[0].prompt).toBe('first');
    expect(adapter.setupCalls[1].prompt).toBe('second');
    expect(ctx.stores.tasks.get(t1.id)!.status).toBe('completed');
    expect(ctx.stores.tasks.get(t2.id)!.status).toBe('completed');
  });

  describe('interactive exit status prompting', () => {
    function makeInteractiveRunner(
      ctx: TestContext,
      adapter: MockAgentAdapter,
      stdinInput: string,
      opts?: Partial<RunnerOptions>,
    ): AgentRunner {
      const { Readable } = require('stream');
      const mockStdin = new Readable({ read() {} });
      // Push input after a tiny delay so readline can attach
      setTimeout(() => {
        mockStdin.push(stdinInput + '\n');
        mockStdin.push(null);
      }, 5);

      // Monkey-patch process.stdin for the duration
      const originalStdin = process.stdin;
      (process as any).stdin = mockStdin;

      const runner = new AgentRunner(ctx, adapter, {
        cloneIndex: 1,
        skipPermissions: false,
        pollInterval: 10,
        nonInteractive: false,
        ...opts,
      });

      // Restore stdin after runner completes
      const origStart = runner.start.bind(runner);
      runner.start = async () => {
        try {
          await origStart();
        } finally {
          (process as any).stdin = originalStdin;
        }
      };

      return runner;
    }

    test('nonInteractive auto-blocks on non-zero exit', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'fail' });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('blocked');
    });

    test('interactive prompt marks completed on "c"', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test c' });

      const runner = makeInteractiveRunner(ctx, adapter, 'c');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('completed');
    });

    test('interactive prompt marks blocked on "b"', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test b' });

      const runner = makeInteractiveRunner(ctx, adapter, 'b');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('blocked');
    });

    test('interactive prompt marks pending on "p" and clears claim fields', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test p' });

      const runner = makeInteractiveRunner(ctx, adapter, 'p');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('pending');
      expect(task.claimedBy).toBeNull();
      expect(task.startedAt).toBeNull();
    });

    test('interactive prompt marks backlogged on "k"', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test k' });

      const runner = makeInteractiveRunner(ctx, adapter, 'k');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('backlogged');
      expect(task.claimedBy).toBeNull();
    });

    test('interactive prompt defaults to blocked on empty input', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test empty' });

      const runner = makeInteractiveRunner(ctx, adapter, '');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('blocked');
    });

    test('interactive prompt defaults to blocked on invalid input', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test invalid' });

      const runner = makeInteractiveRunner(ctx, adapter, 'xyz');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('blocked');
    });

    test('interactive prompt accepts full word "completed"', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test word' });

      const runner = makeInteractiveRunner(ctx, adapter, 'completed');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('completed');
    });

    test('interactive prompt accepts full word "backlogged"', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'test word2' });

      const runner = makeInteractiveRunner(ctx, adapter, 'backlogged');

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      expect(ctx.stores.tasks.get(added.id)!.status).toBe('backlogged');
    });
  });

  describe('timeouts', () => {
    test('task with very short timeout triggers adapter.abort()', async () => {
      addProject(ctx);
      // timeoutMinutes: 0.001 ≈ 60ms total, hard timeout at 60ms
      ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'slow task', timeoutMinutes: 0.001 });

      const runner = makeRunner(ctx, adapter);
      adapter.hangUntilAborted();

      // The runner will hang on run(), timeout fires abort(), run resolves with 1, runner blocks task
      // Stop after first task
      const origRun = adapter.run.bind(adapter);
      adapter.run = async (agentCtx: AgentContext) => {
        const result = await origRun(agentCtx);
        runner.stop();
        return result;
      };

      await runner.start();

      expect(adapter.abortCalls).toBeGreaterThanOrEqual(1);
    });

    test('soft timeout writes mailbox message at 80% mark', async () => {
      addProject(ctx);
      // timeoutMinutes: 0.002 ≈ 120ms total, soft at ~96ms, hard at ~120ms
      ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'mailbox task', timeoutMinutes: 0.002 });

      const runner = makeRunner(ctx, adapter);
      adapter.hangUntilAborted();

      const origRun = adapter.run.bind(adapter);
      adapter.run = async (agentCtx: AgentContext) => {
        const result = await origRun(agentCtx);
        runner.stop();
        return result;
      };

      await runner.start();

      // Check that a mailbox message was written
      const mailboxDir = join(ctx.config.dataDir, 'mailbox', 'agent-01');
      expect(existsSync(mailboxDir)).toBe(true);
      const files = readdirSync(mailboxDir);
      const timeoutFiles = files.filter(f => f.startsWith('timeout-'));
      expect(timeoutFiles.length).toBeGreaterThanOrEqual(1);
    });

    test('timeouts are cleared on normal completion (no abort called)', async () => {
      addProject(ctx);
      // Short timeout, but task completes immediately
      ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'fast task', timeoutMinutes: 10 });

      const runner = makeRunner(ctx, adapter);

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 0;
      };

      await runner.start();

      // Wait a bit to ensure no delayed abort fires
      await new Promise(r => setTimeout(r, 50));

      expect(adapter.abortCalls).toBe(0);
      expect(adapter.forceKillCalls).toBe(0);
    });

    test('task without timeoutMinutes sets no timers', async () => {
      addProject(ctx);
      // No timeoutMinutes (defaults to null)
      ctx.stores.tasks.add({ projectName: 'myproj', prompt: 'no timeout' });

      const runner = makeRunner(ctx, adapter);

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 0;
      };

      await runner.start();

      await new Promise(r => setTimeout(r, 50));

      expect(adapter.abortCalls).toBe(0);
      expect(adapter.forceKillCalls).toBe(0);
    });
  });

  describe('retry logic', () => {
    test('task with retryMax=3 resets to pending with incremented retryCount on failure', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'retry me',
        retryMax: 3,
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1; // fail
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('pending');
      expect(task.retryCount).toBe(1);
      expect(task.claimedBy).toBeNull();
    });

    test('retry with "same" strategy leaves prompt unchanged', async () => {
      addProject(ctx);
      const originalPrompt = 'original prompt text';
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: originalPrompt,
        retryMax: 3,
        retryStrategy: 'same',
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.prompt).toBe(originalPrompt);
    });

    test('retry with "augmented" strategy appends retry context to prompt', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'do something',
        retryMax: 3,
        retryStrategy: 'augmented',
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.prompt).toContain('do something');
      expect(task.prompt).toContain('[RETRY 2/3]');
      expect(task.prompt).toContain('exit code 1');
      expect(task.prompt).toContain('different approach');
    });

    test('retry with "escalate" strategy prepends escalation notice to prompt', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'escalate me',
        retryMax: 3,
        retryStrategy: 'escalate',
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.prompt).toStartWith('[ESCALATED RETRY 2/3]');
      expect(task.prompt).toContain('escalate me');
      expect(task.prompt).toContain('exit code: 1');
    });

    test('retry exhausted: retryMax=2, retryCount=1 blocks instead of retrying', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'exhausted',
        retryMax: 2,
      });

      // Manually set retryCount to 1 (simulating one prior retry)
      ctx.stores.tasks.updateFields(added.id, { retryCount: 1 });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('blocked');
      // retryCount should remain 1 (not incremented)
      expect(task.retryCount).toBe(1);
    });

    test('default retryMax=1 blocks immediately without retry', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'no retry',
        // retryMax defaults to 1
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 1;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('blocked');
      expect(task.retryCount).toBe(0);
    });

    test('blocked task includes exit code in result', async () => {
      addProject(ctx);
      const added = ctx.stores.tasks.add({
        projectName: 'myproj',
        prompt: 'check result',
      });

      const runner = makeRunner(ctx, adapter, { nonInteractive: true });

      adapter.run = async (agentCtx: AgentContext) => {
        adapter.runCalls.push(agentCtx);
        runner.stop();
        return 42;
      };

      await runner.start();

      const task = ctx.stores.tasks.get(added.id)!;
      expect(task.status).toBe('blocked');
      expect(task.result).toBe('exit code 42');
    });
  });
});
