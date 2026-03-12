import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, type Server, type Socket } from 'net';
import { AgentRunner, type RunnerOptions } from '../../../src/runner/runner';
import { serializeMessage, parseMessage, isRequest, createResponse } from '../../../src/daemon/protocol';
import type { AppContext } from '../../../src/container';
import type { Task, TaskInput, TaskLog, TaskStatus, TaskStore } from '../../../src/stores/interfaces';
import type { AgentAdapter, AgentContext } from '../../../src/adapters/agent';

function createMockTask(overrides?: Partial<Task>): Task {
  return {
    id: 't-001',
    projectName: 'test-proj',
    prompt: 'Do the thing',
    status: 'in_progress',
    claimedBy: 'agent-01',
    createdAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    completedAt: null,
    priority: 0,
    timeoutMinutes: null,
    retryMax: 1,
    retryCount: 0,
    retryStrategy: 'same',
    result: null,
    ...overrides,
  };
}

function createMockTaskStore(): TaskStore & { markCalls: Array<{ id: string; status: TaskStatus }> } {
  const markCalls: Array<{ id: string; status: TaskStatus }> = [];
  return {
    markCalls,
    getAll() { return []; },
    get() { return null; },
    add(input: TaskInput): Task { return createMockTask({ prompt: input.prompt }); },
    claim() { return null; },
    mark(id: string, status: TaskStatus) { markCalls.push({ id, status }); },
    updateFields() {},
    getDependencies() { return []; },
    addDependency() {},
    addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog {
      return { ...log, id: 1, createdAt: new Date().toISOString() };
    },
    getLogs() { return []; },
  };
}

function createMockAdapter(): AgentAdapter {
  return {
    setup: async () => {},
    run: async () => 0,
  };
}

function createMockCtx(dataDir: string, taskStore: TaskStore): AppContext {
  return {
    db: null as any,
    stores: {
      projects: {
        getAll: () => [],
        get: (name: string) => ({
          name: 'test-proj',
          repoUrl: 'https://example.com/repo',
          branch: 'main',
          prefix: 'tp',
          isDefault: true,
          trackingType: null,
          trackingProjectKey: null,
          trackingLabel: null,
          trackingInstructions: null,
          workflowType: null,
          workflowInstructions: null,
          workflowAutoMerge: null,
          workflowMergeMethod: null,
        }),
        getDefault: () => ({
          name: 'test-proj',
          repoUrl: 'https://example.com/repo',
          branch: 'main',
          prefix: 'tp',
          isDefault: true,
          trackingType: null,
          trackingProjectKey: null,
          trackingLabel: null,
          trackingInstructions: null,
          workflowType: null,
          workflowInstructions: null,
          workflowAutoMerge: null,
          workflowMergeMethod: null,
        }),
        add: () => {},
        remove: () => false,
        setDefault: () => {},
        update: () => {},
      },
      clones: {
        getAll: () => [],
        get: () => null,
        ensure: () => ({ projectName: 'test-proj', cloneIndex: 1, lockedBy: null, lockedAt: null, path: '' }),
        lock: () => true,
        unlock: () => {},
      },
      tasks: taskStore,
    },
    cmux: {
      identifyTab: async () => null,
      renameWorkspace: async () => {},
      split: async () => null,
      listTabs: async () => [],
    },
    git: {
      clone: async () => {},
      fetch: async () => {},
      checkout: async () => {},
      resetHard: async () => {},
      createBranch: async () => {},
    },
    config: {
      dataDir,
      toolDir: '/tmp/tool',
    },
  };
}

describe('AgentRunner push-mode', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), 'push-mode-test-'));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('falls back to polling when daemon unavailable', async () => {
    const taskStore = createMockTaskStore();
    const ctx = createMockCtx(tempDir, taskStore);
    const adapter = createMockAdapter();

    const runner = new AgentRunner(ctx, adapter, {
      cloneIndex: 1,
      projectName: 'test-proj',
      skipPermissions: true,
      nonInteractive: true,
      daemonSocketPath: join(tempDir, 'nonexistent.sock'),
      pollInterval: 50,
    });

    // Start runner in background, let it poll once, then stop
    const startPromise = runner.start();

    // Give it time to fail daemon connect and enter poll loop
    await new Promise(r => setTimeout(r, 200));
    runner.stop();
    await startPromise;

    // Runner should have started and stopped without errors
    expect(runner.isRunning()).toBe(false);
  });

  test('parses pushed task correctly', async () => {
    const taskStore = createMockTaskStore();
    const ctx = createMockCtx(tempDir, taskStore);
    const adapter = createMockAdapter();
    const sockPath = join(tempDir, 'apd.sock');

    // Create a mock daemon server that responds to runner.ready and pushes a task once
    let pushCount = 0;
    const serverConnections: Socket[] = [];
    const mockServer = createServer((socket) => {
      serverConnections.push(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            if (msg.method === 'runner.ready') {
              // Respond to runner.ready
              socket.write(serializeMessage(createResponse(msg.id, { ok: true })));
              // Push a task only on the first ready
              if (pushCount === 0) {
                pushCount++;
                const task = createMockTask({ id: 't-push-001', prompt: 'Pushed task' });
                socket.write(serializeMessage({
                  id: 'push',
                  result: { type: 'task.assigned', task },
                }));
              }
            }
          }
        }
      });
    });

    await new Promise<void>(resolve => mockServer.listen(sockPath, resolve));

    const runner = new AgentRunner(ctx, adapter, {
      cloneIndex: 1,
      projectName: 'test-proj',
      skipPermissions: true,
      nonInteractive: true,
      daemonSocketPath: sockPath,
    });

    const startPromise = runner.start();

    // Wait for the task to be processed
    await new Promise(r => setTimeout(r, 500));
    runner.stop();
    await startPromise;

    // Task should have been marked completed via the store
    expect(taskStore.markCalls.length).toBeGreaterThanOrEqual(1);
    expect(taskStore.markCalls[0].id).toBe('t-push-001');
    expect(taskStore.markCalls[0].status).toBe('completed');

    mockServer.close();
    for (const s of serverConnections) s.destroy();
  });

  test('re-sends runner.ready after task completion', async () => {
    const taskStore = createMockTaskStore();
    const ctx = createMockCtx(tempDir, taskStore);
    const adapter = createMockAdapter();
    const sockPath = join(tempDir, 'apd.sock');

    let readyCount = 0;
    const serverConnections: Socket[] = [];
    const mockServer = createServer((socket) => {
      serverConnections.push(socket);
      let buffer = '';
      socket.on('data', (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            if (msg.method === 'runner.ready') {
              readyCount++;
              // Respond
              socket.write(serializeMessage(createResponse(msg.id, { ok: true })));
              // Push task only on first ready
              if (readyCount === 1) {
                const task = createMockTask({ id: 't-re-001' });
                socket.write(serializeMessage({
                  id: 'push',
                  result: { type: 'task.assigned', task },
                }));
              }
              // On second ready, don't push — runner will wait
            }
          }
        }
      });
    });

    await new Promise<void>(resolve => mockServer.listen(sockPath, resolve));

    const runner = new AgentRunner(ctx, adapter, {
      cloneIndex: 1,
      projectName: 'test-proj',
      skipPermissions: true,
      nonInteractive: true,
      daemonSocketPath: sockPath,
    });

    const startPromise = runner.start();

    // Wait for task processing + re-ready
    await new Promise(r => setTimeout(r, 800));
    runner.stop();
    await startPromise;

    // Should have sent runner.ready at least twice: initial + after task completion
    expect(readyCount).toBeGreaterThanOrEqual(2);

    mockServer.close();
    for (const s of serverConnections) s.destroy();
  });
});
