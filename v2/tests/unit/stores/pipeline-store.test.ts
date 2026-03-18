import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';

describe('SqlitePipelineStore', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  test('create and get pipeline', () => {
    const pipeline = ctx.stores.pipelines.create({
      id: 'p-1',
      projectName: 'proj',
      name: 'deploy',
      params: { env: 'staging' },
      status: 'pending',
      createdAt: '2025-01-01T00:00:00Z',
    });

    expect(pipeline.id).toBe('p-1');
    expect(pipeline.projectName).toBe('proj');
    expect(pipeline.name).toBe('deploy');
    expect(pipeline.params).toEqual({ env: 'staging' });
    expect(pipeline.status).toBe('pending');
    expect(pipeline.completedAt).toBeNull();

    const fetched = ctx.stores.pipelines.get('p-1');
    expect(fetched).not.toBeNull();
    expect(fetched!.id).toBe('p-1');
    expect(fetched!.params).toEqual({ env: 'staging' });
  });

  test('get returns null for missing id', () => {
    expect(ctx.stores.pipelines.get('p-missing')).toBeNull();
  });

  test('create pipeline with null params', () => {
    const pipeline = ctx.stores.pipelines.create({
      id: 'p-2',
      projectName: 'proj',
      name: 'simple',
      params: null,
      status: 'pending',
      createdAt: '2025-01-01T00:00:00Z',
    });
    expect(pipeline.params).toBeNull();
  });

  test('getAll returns project-scoped pipelines', () => {
    ctx.stores.projects.add({ name: 'other', source: '/other' });

    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'a', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });
    ctx.stores.pipelines.create({
      id: 'p-2', projectName: 'other', name: 'b', params: null,
      status: 'pending', createdAt: '2025-01-01T00:01:00Z',
    });
    ctx.stores.pipelines.create({
      id: 'p-3', projectName: 'proj', name: 'c', params: null,
      status: 'pending', createdAt: '2025-01-01T00:02:00Z',
    });

    const pipelines = ctx.stores.pipelines.getAll('proj');
    expect(pipelines).toHaveLength(2);
    expect(pipelines[0].name).toBe('a');
    expect(pipelines[1].name).toBe('c');
  });

  test('getByProject is equivalent to getAll', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'a', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const all = ctx.stores.pipelines.getAll('proj');
    const byProject = ctx.stores.pipelines.getByProject('proj');
    expect(byProject).toEqual(all);
  });

  test('updateStatus changes status', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'test', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    ctx.stores.pipelines.updateStatus('p-1', 'in_progress');
    expect(ctx.stores.pipelines.get('p-1')!.status).toBe('in_progress');
    expect(ctx.stores.pipelines.get('p-1')!.completedAt).toBeNull();

    ctx.stores.pipelines.updateStatus('p-1', 'completed');
    expect(ctx.stores.pipelines.get('p-1')!.status).toBe('completed');
    expect(ctx.stores.pipelines.get('p-1')!.completedAt).not.toBeNull();
  });

  test('updateStatus sets completedAt for terminal statuses', () => {
    for (const status of ['completed', 'failed', 'cancelled'] as const) {
      ctx.stores.pipelines.create({
        id: `p-${status}`, projectName: 'proj', name: status, params: null,
        status: 'pending', createdAt: '2025-01-01T00:00:00Z',
      });
      ctx.stores.pipelines.updateStatus(`p-${status}`, status);
      expect(ctx.stores.pipelines.get(`p-${status}`)!.completedAt).not.toBeNull();
    }
  });

  // --- refreshStatus ---

  test('refreshStatus returns pending when no tasks', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'empty', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('pending');
    expect(ctx.stores.pipelines.get('p-1')!.status).toBe('pending');
  });

  test('refreshStatus returns completed when all tasks completed', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'done', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });
    ctx.stores.tasks.mark(t1.id, 'completed');
    ctx.stores.tasks.mark(t2.id, 'completed');

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('completed');
  });

  test('refreshStatus returns cancelled when cancelled tasks and no in_progress', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'cancel', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });
    ctx.stores.tasks.mark(t1.id, 'completed');
    ctx.stores.tasks.mark(t2.id, 'cancelled');

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('cancelled');
  });

  test('refreshStatus returns failed when blocked tasks and no in_progress/pending', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'fail', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    const t2 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });
    ctx.stores.tasks.mark(t1.id, 'completed');
    ctx.stores.tasks.mark(t2.id, 'blocked');

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('failed');
  });

  test('refreshStatus returns in_progress when tasks are actively running', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'running', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });
    ctx.stores.tasks.mark(t1.id, 'in_progress', { claimedBy: 'agent-1' });

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('in_progress');
  });

  test('refreshStatus returns in_progress when pending with completed siblings', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'mixed', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    const t1 = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });
    ctx.stores.tasks.mark(t1.id, 'completed');

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('in_progress');
  });

  test('refreshStatus returns pending when all tasks are pending', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'waiting', params: null,
      status: 'in_progress', createdAt: '2025-01-01T00:00:00Z',
    });

    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'a', pipelineId: 'p-1' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'b', pipelineId: 'p-1' });

    const status = ctx.stores.pipelines.refreshStatus('p-1');
    expect(status).toBe('pending');
  });

  // --- getByPipeline on TaskStore ---

  test('getByPipeline returns tasks for a pipeline', () => {
    ctx.stores.pipelines.create({
      id: 'p-1', projectName: 'proj', name: 'test', params: null,
      status: 'pending', createdAt: '2025-01-01T00:00:00Z',
    });

    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'pipeline task 1', pipelineId: 'p-1', pipelineStepId: 'step-1' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'pipeline task 2', pipelineId: 'p-1', pipelineStepId: 'step-2' });
    ctx.stores.tasks.add({ projectName: 'proj', prompt: 'unrelated task' });

    const pipelineTasks = ctx.stores.tasks.getByPipeline('p-1');
    expect(pipelineTasks).toHaveLength(2);
    expect(pipelineTasks[0].prompt).toBe('pipeline task 1');
    expect(pipelineTasks[0].pipelineId).toBe('p-1');
    expect(pipelineTasks[0].pipelineStepId).toBe('step-1');
    expect(pipelineTasks[1].prompt).toBe('pipeline task 2');
  });

  test('getByPipeline returns empty for unknown pipeline', () => {
    expect(ctx.stores.tasks.getByPipeline('p-nonexistent')).toEqual([]);
  });

  test('task pipelineId and pipelineStepId default to null', () => {
    const task = ctx.stores.tasks.add({ projectName: 'proj', prompt: 'no pipeline' });
    expect(task.pipelineId).toBeNull();
    expect(task.pipelineStepId).toBeNull();
  });
});
