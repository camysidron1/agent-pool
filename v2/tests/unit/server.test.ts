import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import {
  createAgentPoolServer,
  type AgentPoolEvent,
  type AgentPoolServer,
  type AgentPoolServerOptions,
} from '../../src/server.js';
import { createDatabase } from '../../src/stores/sqlite/connection.js';
import { applyMigrations } from '../../src/stores/sqlite/schema.js';
import { SqliteCloneStore } from '../../src/stores/sqlite/clone-store.js';
import { SqlitePipelineStore } from '../../src/stores/sqlite/pipeline-store.js';
import { SqliteProjectStore } from '../../src/stores/sqlite/project-store.js';
import { SqliteTaskStore } from '../../src/stores/sqlite/task-store.js';
import type { Task } from '../../src/stores/interfaces.js';

type SeedStores = {
  projects: SqliteProjectStore;
  clones: SqliteCloneStore;
  tasks: SqliteTaskStore;
  pipelines: SqlitePipelineStore;
};

type TestServer = {
  dataDir: string;
  pool: AgentPoolServer;
  cleanup: () => void;
};

const createdServers: TestServer[] = [];

afterEach(() => {
  while (createdServers.length > 0) {
    createdServers.pop()?.cleanup();
  }
});

describe('Agent Pool server package entrypoint', () => {
  test('imports without CLI side effects', async () => {
    const mod = await import('../../src/server.js');
    expect(typeof mod.createAgentPoolServer).toBe('function');
  });

  test('opens a v2 database and closes cleanly', async () => {
    const server = createSeededServer();
    const snapshot = await server.pool.getSnapshot();

    expect(snapshot.project.name).toBe('proj');
    expect(snapshot.projects.map((project) => project.name)).toEqual(['proj']);
    expect(snapshot.daemon.running).toBe(false);

    server.pool.close();
    await expect(server.pool.getSnapshot()).rejects.toThrow('closed');
  });

  test('creates and updates tasks with dependency validation', async () => {
    const server = createSeededServer();
    const dependency = await server.pool.createTask({ prompt: 'first task', priority: 3 });
    const task = await server.pool.createTask({
      prompt: 'second task',
      dependsOn: [dependency.task.id],
      timeoutMinutes: 10,
      retryMax: 2,
      retryStrategy: 'augmented',
      branch: 'feature/demo',
    });

    expect(task.task.dependsOn).toEqual([dependency.task.id]);
    expect(task.dependencies.map((candidate) => candidate.id)).toEqual([dependency.task.id]);
    expect(task.task.timeoutMinutes).toBe(10);
    expect(task.task.retryMax).toBe(2);
    expect(task.task.retryStrategy).toBe('augmented');
    expect(task.task.branch).toBe('feature/demo');

    const updated = await server.pool.updateTask({
      taskId: task.task.id,
      prompt: 'updated task',
      priority: 9,
      result: 'partial result',
    });

    expect(updated.task.prompt).toBe('updated task');
    expect(updated.task.priority).toBe(9);
    expect(updated.task.result).toBe('partial result');

    await expect(server.pool.createTask({ prompt: 'bad dep', dependsOn: ['missing-task'] })).rejects.toThrow(/does not exist/);
  });

  test('supports cancel, backlog, activate, and unblock controls', async () => {
    const server = createSeededServer(({ tasks }) => {
      tasks.add({ projectName: 'proj', prompt: 'blocked', status: 'blocked' });
    });

    const backlog = await server.pool.createTask({ prompt: 'move to backlog' });
    expect((await server.pool.backlogTask({ taskId: backlog.task.id })).task.status).toBe('backlogged');
    expect((await server.pool.activateTask({ taskId: backlog.task.id })).task.status).toBe('pending');

    const blocked = (await server.pool.getSnapshot()).tasks.find((task) => task.prompt === 'blocked');
    expect(blocked).toBeDefined();
    expect((await server.pool.unblockTask({ taskId: blocked!.id })).task.status).toBe('pending');

    const cancel = await server.pool.createTask({ prompt: 'cancel me' });
    expect((await server.pool.cancelTask({ taskId: cancel.task.id })).task.status).toBe('cancelled');
  });

  test('derives snapshots from tasks, clones, logs, and heartbeats', async () => {
    let claimedTask: Task | null = null;
    const server = createSeededServer(({ clones, tasks }) => {
      clones.add('proj', 0, 'main');
      clones.lock('proj', 0, 'surface:1');
      clones.add('proj', 1, 'main');
      clones.lock('proj', 1, 'surface:2');
      clones.add('proj', 2, 'main');

      tasks.add({ projectName: 'proj', prompt: 'working task' });
      claimedTask = tasks.claim('proj', 'agent-00');
      const unlockedClaimedTask = tasks.add({ projectName: 'proj', prompt: 'unlocked claimed task' });
      tasks.mark(unlockedClaimedTask.id, 'in_progress', { claimedBy: 'agent-02' });

      const logPath = join(serverTempDataDir(), 'missing.log');
      tasks.addLog({
        taskId: claimedTask!.id,
        agentId: 'agent-00',
        logPath,
        startedAt: new Date().toISOString(),
        completedAt: null,
        exitCode: null,
      });
    }, { staleHeartbeatMs: 60_000 });

    writeHeartbeat(server.dataDir, 'agent-00', claimedTask!.id, 'running', new Date());
    writeHeartbeat(server.dataDir, 'agent-01', 'stale-task', 'tool', new Date(Date.now() - 120_000));

    const snapshot = await server.pool.getSnapshot();
    expect(snapshot.queue.inProgress).toBe(2);
    expect(snapshot.agents.find((agent) => agent.agentId === 'agent-00')?.status).toBe('working');
    expect(snapshot.agents.find((agent) => agent.agentId === 'agent-01')?.status).toBe('stale');
    expect(snapshot.agents.find((agent) => agent.agentId === 'agent-02')?.status).toBe('offline');

    const detail = await server.pool.getTaskDetail({ taskId: claimedTask!.id });
    expect(detail.activeAgent?.agentId).toBe('agent-00');
    expect(detail.logs.length).toBe(1);
  });

  test('reads task log content with tailing', async () => {
    let taskId = '';
    let logPath = '';
    const server = createSeededServer(({ tasks }) => {
      const task = tasks.add({ projectName: 'proj', prompt: 'logged task' });
      taskId = task.id;
      logPath = join(serverTempDataDir(), 'task.log');
      writeFile(logPath, 'one\ntwo\nthree\nfour\n');
      tasks.addLog({
        taskId,
        agentId: 'agent-00',
        logPath,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 0,
      });
    });

    const read = await server.pool.readTaskLog({ taskId, tailLines: 2 });
    expect(read.exists).toBe(true);
    expect(read.truncated).toBe(true);
    expect(read.text).toBe('four\n');
  });

  test('SSE emits initial snapshots, persisted events, and heartbeat snapshot changes', async () => {
    const server = createSeededServer(undefined, { ssePollIntervalMs: 25 });
    const response = server.pool.createSseResponse();
    expect(response.headers.get('content-type')).toContain('text/event-stream');

    const reader = response.body!.getReader();
    const initial = await readNextSse(reader, (event) => event.type === 'snapshot');
    if (initial.type !== 'snapshot') throw new Error('expected initial snapshot event');
    expect(initial.snapshot.tasks.length).toBe(0);

    const created = await server.pool.createTask({ prompt: 'from SSE test' });
    const poolEvent = await readNextSse(reader, (event) => event.type === 'pool-event');
    if (poolEvent.type !== 'pool-event') throw new Error('expected pool event');
    expect(poolEvent.event.type).toBe('task.created');
    expect(poolEvent.event.payload.taskId).toBe(created.task.id);

    writeHeartbeat(server.dataDir, 'agent-00', created.task.id, 'running', new Date());
    const snapshot = await readNextSse(reader, (event) =>
      event.type === 'snapshot' && event.snapshot.agents.some((agent) => agent.agentId === 'agent-00'),
    );
    if (snapshot.type !== 'snapshot') throw new Error('expected heartbeat snapshot event');
    expect(snapshot.snapshot.agents.find((agent) => agent.agentId === 'agent-00')?.status).toBe('offline');

    await reader.cancel();
  });

  test('packed package imports from a separate Bun app', async () => {
    const server = createSeededServer();
    const packageDir = resolve(import.meta.dir, '..', '..');
    const packDir = mkdtempSync(join(tmpdir(), 'ap-pack-'));
    const fixtureDir = mkdtempSync(join(tmpdir(), 'ap-package-fixture-'));
    createdServers.push({
      dataDir: packDir,
      pool: { close: () => undefined } as AgentPoolServer,
      cleanup: () => {
        rmSync(packDir, { recursive: true, force: true });
        rmSync(fixtureDir, { recursive: true, force: true });
      },
    });

    const pack = Bun.spawnSync(
      ['bun', 'pm', 'pack', '--destination', packDir, '--quiet'],
      { cwd: packageDir, stdout: 'pipe', stderr: 'pipe' },
    );
    if (pack.exitCode !== 0) throw new Error(new TextDecoder().decode(pack.stderr));
    const tarball = readdirSync(packDir).find((file) => file.endsWith('.tgz'));
    if (!tarball) throw new Error('package tarball was not created');

    writeFile(join(fixtureDir, 'package.json'), JSON.stringify({ type: 'module' }));
    const add = Bun.spawnSync(['bun', 'add', join(packDir, tarball)], {
      cwd: fixtureDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (add.exitCode !== 0) throw new Error(new TextDecoder().decode(add.stderr));

    writeFile(join(fixtureDir, 'smoke.ts'), `
      import { createAgentPoolServer } from '@agent-pool/tui';
      import { createAgentPoolServer as createFromSubpath } from '@agent-pool/tui/server';
      const pool = createAgentPoolServer({ dataDir: process.env.DATA_DIR, toolDir: process.env.TOOL_DIR });
      if (typeof createFromSubpath !== 'function') throw new Error('subpath export missing');
      await pool.createTask({ prompt: 'packed package task' });
      const snapshot = await pool.getSnapshot();
      console.log('smoke:' + snapshot.tasks.length);
      pool.close();
    `);

    const run = Bun.spawnSync(['bun', 'run', 'smoke.ts'], {
      cwd: fixtureDir,
      env: {
        ...process.env,
        DATA_DIR: server.dataDir,
        TOOL_DIR: packageDir,
      },
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (run.exitCode !== 0) throw new Error(new TextDecoder().decode(run.stderr));
    expect(new TextDecoder().decode(run.stdout)).toContain('smoke:1');
  }, 30_000);
});

function createSeededServer(
  seed?: (stores: SeedStores) => void,
  options: Partial<AgentPoolServerOptions> = {},
): TestServer {
  const dataDir = mkdtempSync(join(tmpdir(), 'ap-server-test-'));
  const db = createDatabase(join(dataDir, 'agent-pool.db'));
  applyMigrations(db);
  const stores: SeedStores = {
    projects: new SqliteProjectStore(db),
    clones: new SqliteCloneStore(db),
    tasks: new SqliteTaskStore(db),
    pipelines: new SqlitePipelineStore(db),
  };
  stores.projects.add({ name: 'proj', source: '/tmp/source', prefix: 'proj', branch: 'main' });
  stores.projects.setDefault('proj');
  seed?.(stores);
  db.close();

  const pool = createAgentPoolServer({
    dataDir,
    toolDir: dataDir,
    daemonStatusTimeoutMs: 10,
    ...options,
  });
  const server = {
    dataDir,
    pool,
    cleanup: () => {
      pool.close();
      rmSync(dataDir, { recursive: true, force: true });
    },
  };
  createdServers.push(server);
  return server;
}

function writeHeartbeat(dataDir: string, agentId: string, taskId: string, lastTool: string, timestamp: Date): void {
  writeFile(join(dataDir, 'heartbeats', `${agentId}.json`), JSON.stringify({
    timestamp: timestamp.toISOString(),
    pid: process.pid,
    task_id: taskId,
    last_tool: lastTool,
  }));
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function serverTempDataDir(): string {
  const path = mkdtempSync(join(tmpdir(), 'ap-server-file-'));
  createdServers.push({
    dataDir: path,
    pool: { close: () => undefined } as AgentPoolServer,
    cleanup: () => rmSync(path, { recursive: true, force: true }),
  });
  return path;
}

async function readNextSse(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: AgentPoolEvent) => boolean,
): Promise<AgentPoolEvent> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 2000;

  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for SSE event')), Math.max(1, deadline - Date.now()));
      }),
    ]);

    if (read.done) throw new Error('SSE stream closed');
    buffer += decoder.decode(read.value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';

    for (const message of messages) {
      const dataLine = message.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice('data:'.length).trim()) as AgentPoolEvent;
      if (predicate(event)) return event;
    }
  }

  throw new Error('timed out waiting for SSE event');
}
