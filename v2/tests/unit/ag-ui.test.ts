import { afterEach, describe, expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { dirname, join, resolve } from 'path';

import { createAgentPoolAgUiHandler } from '../../src/ag-ui.js';
import { createAgentPoolServer, type AgentPoolServer, type AgentPoolServerOptions } from '../../src/server.js';
import { createDatabase } from '../../src/stores/sqlite/connection.js';
import { applyMigrations } from '../../src/stores/sqlite/schema.js';
import { SqliteCloneStore } from '../../src/stores/sqlite/clone-store.js';
import { SqlitePipelineStore } from '../../src/stores/sqlite/pipeline-store.js';
import { SqliteProjectStore } from '../../src/stores/sqlite/project-store.js';
import { SqliteTaskStore } from '../../src/stores/sqlite/task-store.js';
import type { TaskStatus } from '../../src/stores/interfaces.js';

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

describe('Agent Pool AG-UI adapter', () => {
  test('dispatch mode emits AG-UI events and finishes with a review interrupt', async () => {
    const server = createSeededServer();
    const handler = createAgentPoolAgUiHandler(server.pool, { pollIntervalMs: 25 });
    const response = await handler(agUiRequest({
      threadId: 'thread-1',
      runId: 'run-1',
      messages: [{ id: 'm-1', role: 'user', content: 'Build the thing' }],
      forwardedProps: { agentPool: { mode: 'dispatch' } },
    }));

    expect(response.headers.get('content-type')).toContain('text/event-stream');
    const reader = response.body!.getReader();
    expect((await readAgUiEvent(reader, (event) => event.type === 'RUN_STARTED')).type).toBe('RUN_STARTED');
    expect((await readAgUiEvent(reader, (event) => event.type === 'STATE_SNAPSHOT')).type).toBe('STATE_SNAPSHOT');
    expect((await readAgUiEvent(reader, (event) => event.type === 'ACTIVITY_SNAPSHOT')).activityType).toBe('agent_pool_office');

    const created = await readAgUiEvent(reader, (event) => event.type === 'CUSTOM' && event.name === 'agent_pool.task_created');
    const taskId = created.value.taskId as string;
    markTask(server.dataDir, taskId, 'review_requested', { claimedBy: 'agent-00' });

    const finished = await readAgUiEvent(reader, (event) => event.type === 'RUN_FINISHED');
    expect(finished.result.outcome).toEqual({ type: 'interrupt', reason: 'agent_pool:review_required' });
    expect(finished.result.taskId).toBe(taskId);
    await reader.cancel();
  });

  test('observe mode streams pool state changes without creating tasks', async () => {
    const server = createSeededServer();
    const handler = createAgentPoolAgUiHandler(server.pool, { pollIntervalMs: 25 });
    const response = await handler(agUiRequest({
      threadId: 'thread-2',
      runId: 'run-2',
      messages: [],
      forwardedProps: { agentPool: { mode: 'observe' } },
    }));

    const reader = response.body!.getReader();
    const initial = await readAgUiEvent(reader, (event) => event.type === 'STATE_SNAPSHOT');
    expect(initial.snapshot.tasks.length).toBe(0);

    await server.pool.createTask({ prompt: 'observe me' });
    const updated = await readAgUiEvent(reader, (event) =>
      event.type === 'STATE_SNAPSHOT' && event.snapshot.tasks.length === 1,
    );
    expect(updated.snapshot.tasks[0].promptPreview).toContain('observe me');
    await reader.cancel();
  });

  test('feedback mode writes the active clone mailbox', async () => {
    let taskId = '';
    const server = createSeededServer(({ clones, tasks, dataDir }) => {
      clones.add('proj', 0, 'main');
      clones.lock('proj', 0, 'surface:1');
      mkdirSync(join(dataDir, 'proj-00'), { recursive: true });
      const task = tasks.add({ projectName: 'proj', prompt: 'active task' });
      taskId = tasks.claim('proj', 'agent-00')!.id;
      expect(task.id).toBe(taskId);
    });

    const handler = createAgentPoolAgUiHandler(server.pool);
    const response = await handler(agUiRequest({
      threadId: 'thread-3',
      runId: 'run-3',
      messages: [{ id: 'm-1', role: 'user', content: 'Please use blue' }],
      forwardedProps: { agentPool: { mode: 'feedback', taskId } },
    }));

    const reader = response.body!.getReader();
    const delivered = await readAgUiEvent(reader, (event) => event.type === 'CUSTOM' && event.name === 'agent_pool.feedback_delivered');
    expect(delivered.value.taskId).toBe(taskId);
    expect(readFileSync(join(server.dataDir, 'proj-00', '.mailbox'), 'utf-8')).toBe('Please use blue');
    await readAgUiEvent(reader, (event) => event.type === 'RUN_FINISHED');
    await reader.cancel();

    const idle = await server.pool.createTask({ prompt: 'not active' });
    await expect(server.pool.sendTaskFeedback({ taskId: idle.task.id, message: 'hello' })).rejects.toThrow('not actively claimed');
  });

  test('review mode accepts and request-changes requeues review tasks', async () => {
    let acceptId = '';
    let changesId = '';
    const server = createSeededServer(({ tasks }) => {
      acceptId = tasks.add({ projectName: 'proj', prompt: 'accept me' }).id;
      tasks.mark(acceptId, 'review_requested', { claimedBy: 'agent-00' });
      changesId = tasks.add({ projectName: 'proj', prompt: 'revise me' }).id;
      tasks.mark(changesId, 'review_requested', { claimedBy: 'agent-00' });
    });

    const handler = createAgentPoolAgUiHandler(server.pool);
    const acceptResponse = await handler(agUiRequest({
      threadId: 'thread-4',
      runId: 'run-4',
      messages: [],
      forwardedProps: { agentPool: { mode: 'review', taskId: acceptId, decision: 'accept' } },
    }));
    await readAgUiEvent(acceptResponse.body!.getReader(), (event) => event.type === 'RUN_FINISHED');
    expect((await server.pool.getTaskDetail({ taskId: acceptId })).task.status).toBe('completed');

    const changesResponse = await handler(agUiRequest({
      threadId: 'thread-5',
      runId: 'run-5',
      messages: [],
      forwardedProps: { agentPool: { mode: 'review', taskId: changesId, decision: 'request_changes', feedback: 'Add tests' } },
    }));
    await readAgUiEvent(changesResponse.body!.getReader(), (event) => event.type === 'RUN_FINISHED');
    const changed = await server.pool.getTaskDetail({ taskId: changesId });
    expect(changed.task.status).toBe('pending');
    expect(changed.task.prompt).toContain('Add tests');
  });

  test('review artifact discovery prefers manifest and falls back to logs', async () => {
    let manifestTaskId = '';
    let fallbackTaskId = '';
    const server = createSeededServer(({ clones, tasks, dataDir }) => {
      clones.add('proj', 0, 'main');
      const clonePath = join(dataDir, 'proj-00');
      writeFile(join(clonePath, 'agent-docs', 'reviews', 'placeholder'), '');
      const manifestTask = tasks.add({ projectName: 'proj', prompt: 'manifest task' });
      manifestTaskId = manifestTask.id;
      tasks.mark(manifestTaskId, 'review_requested', { claimedBy: 'agent-00' });
      writeFile(join(clonePath, 'agent-docs', 'reviews', `${manifestTaskId}.json`), JSON.stringify({
        taskId: manifestTaskId,
        summaryMarkdown: 'Manifest summary',
        changedFiles: ['src/a.ts'],
        diffSummary: '1 file changed',
        artifacts: [{ kind: 'file', title: 'src/a.ts', path: 'src/a.ts' }],
        links: ['https://example.com/pr/1'],
        presentation: ['Slide one'],
      }));

      const fallbackTask = tasks.add({ projectName: 'proj', prompt: 'fallback task' });
      fallbackTaskId = fallbackTask.id;
      tasks.mark(fallbackTaskId, 'review_requested', { result: 'Fallback result' });
      const logPath = join(dataDir, 'fallback.log');
      writeFile(logPath, 'line one\nline two\n');
      tasks.addLog({
        taskId: fallbackTaskId,
        agentId: 'agent-00',
        logPath,
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
        exitCode: 0,
      });
    });

    const manifestReview = await server.pool.getTaskReview({ taskId: manifestTaskId });
    expect(manifestReview.source).toBe('manifest');
    expect(manifestReview.summaryMarkdown).toBe('Manifest summary');
    expect(manifestReview.changedFiles).toEqual(['src/a.ts']);

    const fallbackReview = await server.pool.getTaskReview({ taskId: fallbackTaskId });
    expect(fallbackReview.source).toBe('fallback');
    expect(fallbackReview.summaryMarkdown).toBe('Fallback result');
    expect(fallbackReview.artifacts.some((artifact) => artifact.kind === 'log')).toBe(true);
  });

  test('packed package AG-UI export works with HttpAgent', async () => {
    const server = createSeededServer();
    const packageDir = resolve(import.meta.dir, '..', '..');
    const packDir = mkdtemp('ap-agui-pack-');
    const fixtureDir = mkdtemp('ap-agui-fixture-');
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
    const add = Bun.spawnSync(['bun', 'add', join(packDir, tarball), '@ag-ui/client@0.0.53'], {
      cwd: fixtureDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (add.exitCode !== 0) throw new Error(new TextDecoder().decode(add.stderr));

    writeFile(join(fixtureDir, 'smoke.ts'), `
      import { Database } from 'bun:sqlite';
      import { join } from 'path';
      import { HttpAgent } from '@ag-ui/client';
      import { createAgentPoolServer } from '@agent-pool/tui/server';
      import { createAgentPoolAgUiHandler } from '@agent-pool/tui/ag-ui';

      const pool = createAgentPoolServer({ dataDir: process.env.DATA_DIR, toolDir: process.env.TOOL_DIR });
      const task = await pool.createTask({ prompt: 'packed AG-UI review task' });
      const db = new Database(join(process.env.DATA_DIR, 'agent-pool.db'));
      db.query("UPDATE tasks SET status = 'review_requested', completed_at = ?, claimed_by = ? WHERE id = ?").run(new Date().toISOString(), 'agent-00', task.task.id);
      db.close();

      const handler = createAgentPoolAgUiHandler(pool, { pollIntervalMs: 10 });
      const server = Bun.serve({ port: 0, fetch: handler });
      const agent = new HttpAgent({ url: 'http://127.0.0.1:' + server.port });
      const result = await agent.runAgent({
        forwardedProps: { agentPool: { mode: 'review', taskId: task.task.id, decision: 'accept' } },
      });
      console.log('agui:' + result.result.outcome.type + ':' + result.result.taskId);
      server.stop(true);
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
    expect(new TextDecoder().decode(run.stdout)).toContain('agui:review_submitted:');
  }, 45_000);
});

type SeedStores = {
  projects: SqliteProjectStore;
  clones: SqliteCloneStore;
  tasks: SqliteTaskStore;
  pipelines: SqlitePipelineStore;
  dataDir: string;
};

function createSeededServer(
  seed?: (stores: SeedStores) => void,
  options: Partial<AgentPoolServerOptions> = {},
): TestServer {
  const dataDir = mkdtemp('ap-agui-test-');
  const db = createDatabase(join(dataDir, 'agent-pool.db'));
  applyMigrations(db);
  const stores: SeedStores = {
    projects: new SqliteProjectStore(db),
    clones: new SqliteCloneStore(db),
    tasks: new SqliteTaskStore(db),
    pipelines: new SqlitePipelineStore(db),
    dataDir,
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

function markTask(
  dataDir: string,
  taskId: string,
  status: TaskStatus,
  fields: { claimedBy?: string | null } = {},
): void {
  const db = createDatabase(join(dataDir, 'agent-pool.db'));
  applyMigrations(db);
  const store = new SqliteTaskStore(db);
  store.mark(taskId, status, { claimedBy: fields.claimedBy ?? null });
  db.close();
}

function agUiRequest(body: Record<string, unknown>): Request {
  return new Request('http://agent-pool.test/ag-ui', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

async function readAgUiEvent(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  predicate: (event: any) => boolean,
): Promise<any> {
  const decoder = new TextDecoder();
  let buffer = '';
  const deadline = Date.now() + 3000;

  while (Date.now() < deadline) {
    const read = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((_, reject) => {
        setTimeout(() => reject(new Error('timed out waiting for AG-UI event')), Math.max(1, deadline - Date.now()));
      }),
    ]);

    if (read.done) throw new Error('AG-UI stream closed');
    buffer += decoder.decode(read.value, { stream: true });
    const messages = buffer.split('\n\n');
    buffer = messages.pop() ?? '';

    for (const message of messages) {
      const dataLine = message.split('\n').find((line) => line.startsWith('data:'));
      if (!dataLine) continue;
      const event = JSON.parse(dataLine.slice('data:'.length).trim());
      if (predicate(event)) return event;
    }
  }

  throw new Error('timed out waiting for AG-UI event');
}

function writeFile(path: string, contents: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, contents);
}

function mkdtemp(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}
