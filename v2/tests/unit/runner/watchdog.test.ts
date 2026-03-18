import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdir, writeFile, readdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { Watchdog, type HeartbeatData } from '../../../src/runner/watchdog.js';
import type { Task, TaskInput, TaskLog, TaskStatus, TaskStore } from '../../../src/stores/interfaces.js';
import { EventBus, type PoolEvent } from '../../../src/daemon/event-bus.js';

/** Create a minimal mock TaskStore that records mark() calls. */
function createMockTaskStore(): TaskStore & {
  markCalls: Array<{ id: string; status: TaskStatus; fields?: Partial<Task> }>;
} {
  const markCalls: Array<{ id: string; status: TaskStatus; fields?: Partial<Task> }> = [];
  return {
    markCalls,
    getAll() { return []; },
    get() { return null; },
    add(input: TaskInput): Task {
      return {
        id: 't-mock',
        projectName: input.projectName,
        prompt: input.prompt,
        status: input.status ?? 'pending',
        claimedBy: null,
        createdAt: new Date().toISOString(),
        startedAt: null,
        completedAt: null,
        priority: 0,
        timeoutMinutes: null,
        retryMax: 1,
        retryCount: 0,
        retryStrategy: 'same',
        result: null,
      };
    },
    claim() { return null; },
    mark(id: string, status: TaskStatus, fields?: Partial<Task>) {
      markCalls.push({ id, status, fields });
    },
    updateFields() {},
    getDependencies() { return []; },
    addDependency() {},
    addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog {
      return { ...log, id: 1, createdAt: new Date().toISOString() };
    },
    getLogs() { return []; },
  };
}

async function writeHeartbeatFile(
  dir: string,
  agentId: string,
  data: HeartbeatData,
) {
  const hbDir = join(dir, 'heartbeats');
  await mkdir(hbDir, { recursive: true });
  await writeFile(join(hbDir, `${agentId}.json`), JSON.stringify(data));
}

describe('Watchdog', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await new Promise<string>((resolve) => {
      const dir = join(tmpdir(), `watchdog-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      mkdir(dir, { recursive: true }).then(() => resolve(dir));
    });
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test('detects stale heartbeat', async () => {
    const sixMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, 'agent-01', {
      timestamp: sixMinAgo,
      pid: process.pid, // alive PID, but stale timestamp
      task_id: 't-100',
      last_tool: 'Read',
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].agentId).toBe('agent-01');
    expect(stuck[0].taskId).toBe('t-100');
    expect(stuck[0].reason).toBe('stale_heartbeat');
    expect(stuck[0].lastHeartbeat).toBe(sixMinAgo);
  });

  test('detects dead PID', async () => {
    const recentTimestamp = new Date().toISOString();
    await writeHeartbeatFile(tempDir, 'agent-02', {
      timestamp: recentTimestamp,
      pid: 999999, // almost certainly not alive
      task_id: 't-200',
      last_tool: 'Bash',
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].agentId).toBe('agent-02');
    expect(stuck[0].reason).toBe('dead_pid');
  });

  test('ignores fresh heartbeats', async () => {
    const now = new Date().toISOString();
    await writeHeartbeatFile(tempDir, 'agent-03', {
      timestamp: now,
      pid: process.pid, // current process, definitely alive
      task_id: 't-300',
      last_tool: 'Edit',
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(0);
  });

  test('marks task blocked when detecting stuck agent', async () => {
    const store = createMockTaskStore();
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await writeHeartbeatFile(tempDir, 'agent-04', {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: 't-400',
      last_tool: 'Read',
    });

    const logs: string[] = [];
    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      store,
      (msg) => logs.push(msg),
    );

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);

    // Simulate what start() does: handle stuck agents
    await (watchdog as any).handleStuckAgents(stuck);

    expect(store.markCalls).toHaveLength(1);
    expect(store.markCalls[0].id).toBe('t-400');
    expect(store.markCalls[0].status).toBe('blocked');
    expect(logs.length).toBeGreaterThan(0);
  });

  test('cleans up heartbeat file after detection', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, 'agent-05', {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: 't-500',
      last_tool: 'Write',
    });

    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      null,
      () => {},
    );

    const stuck = await watchdog.scan();
    await (watchdog as any).handleStuckAgents(stuck);

    const remaining = await readdir(join(tempDir, 'heartbeats'));
    expect(remaining.filter((f: string) => f.endsWith('.json'))).toHaveLength(0);
  });

  test('returns empty when no heartbeat directory exists', async () => {
    const watchdog = new Watchdog({
      dataDir: join(tempDir, 'nonexistent'),
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(0);
  });

  test('writeHeartbeat creates file correctly', async () => {
    await Watchdog.writeHeartbeat(tempDir, 'agent-06', 't-600', 'Grep');

    const files = await readdir(join(tempDir, 'heartbeats'));
    expect(files).toContain('agent-06.json');

    const raw = await Bun.file(
      join(tempDir, 'heartbeats', 'agent-06.json'),
    ).text();
    const data: HeartbeatData = JSON.parse(raw);
    expect(data.task_id).toBe('t-600');
    expect(data.last_tool).toBe('Grep');
    expect(data.pid).toBe(process.pid);
  });

  test('clearHeartbeat removes file', async () => {
    await Watchdog.writeHeartbeat(tempDir, 'agent-07', 't-700');
    await Watchdog.clearHeartbeat(tempDir, 'agent-07');

    const files = await readdir(join(tempDir, 'heartbeats'));
    expect(files.filter((f: string) => f.endsWith('.json'))).toHaveLength(0);
  });

  test('clearHeartbeat is idempotent', async () => {
    // Should not throw when file doesn't exist
    await Watchdog.clearHeartbeat(tempDir, 'nonexistent-agent');
  });

  test('emits agent.stuck event via EventBus', async () => {
    const eventBus = new EventBus(null, () => {});
    const events: PoolEvent[] = [];
    eventBus.on('agent.stuck', (event) => { events.push(event); });

    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, 'agent-ev-01', {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: 't-ev-100',
      last_tool: 'Read',
    });

    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      null,
      () => {},
      eventBus,
    );

    const stuck = await watchdog.scan();
    await (watchdog as any).handleStuckAgents(stuck);

    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('agent.stuck');
    expect(events[0].payload.agentId).toBe('agent-ev-01');
    expect(events[0].payload.taskId).toBe('t-ev-100');
    expect(events[0].payload.reason).toBe('stale_heartbeat');
    expect(events[0].payload.lastHeartbeat).toBe(oldTimestamp);
    expect(events[0].timestamp).toBeDefined();
  });

  test('does not emit events when no EventBus provided', async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, 'agent-ev-02', {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: 't-ev-200',
      last_tool: 'Read',
    });

    // No eventBus passed — should work without errors
    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      null,
      () => {},
    );

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);
    await (watchdog as any).handleStuckAgents(stuck);
    // No assertion needed — just verifying no errors thrown
  });

  test('start and stop lifecycle', async () => {
    const watchdog = new Watchdog({
      dataDir: tempDir,
      scanIntervalMs: 100,
    });

    watchdog.start();
    // Starting again is idempotent
    watchdog.start();

    // Let it run briefly
    await new Promise((r) => setTimeout(r, 50));

    watchdog.stop();
    // Stopping again is idempotent
    watchdog.stop();
  });
});
