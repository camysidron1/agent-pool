import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';

describe('SqliteCloneStore', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
    // Need a project for foreign key
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
  });

  afterEach(() => {
    ctx.cleanup();
  });

  test('add clone and getAll', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.add('proj', 1, 'main');
    const all = ctx.stores.clones.getAll('proj');
    expect(all.length).toBe(2);
    expect(all[0].cloneIndex).toBe(0);
    expect(all[1].cloneIndex).toBe(1);
  });

  test('get by project and index', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    const clone = ctx.stores.clones.get('proj', 0);
    expect(clone).not.toBeNull();
    expect(clone!.projectName).toBe('proj');
    expect(clone!.cloneIndex).toBe(0);
    expect(clone!.branch).toBe('main');
    expect(clone!.locked).toBe(false);
    expect(clone!.workspaceId).toBe('');
  });

  test('get returns null for missing clone', () => {
    expect(ctx.stores.clones.get('proj', 99)).toBeNull();
  });

  test('lock and unlock cycle', () => {
    ctx.stores.clones.add('proj', 0, 'main');

    ctx.stores.clones.lock('proj', 0, 'ws-123');
    let clone = ctx.stores.clones.get('proj', 0)!;
    expect(clone.locked).toBe(true);
    expect(clone.workspaceId).toBe('ws-123');
    expect(clone.lockedAt).not.toBeNull();

    ctx.stores.clones.unlock('proj', 0);
    clone = ctx.stores.clones.get('proj', 0)!;
    expect(clone.locked).toBe(false);
    expect(clone.workspaceId).toBe('');
    expect(clone.lockedAt).toBeNull();
  });

  test('findFree returns first unlocked clone', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.add('proj', 1, 'main');
    ctx.stores.clones.lock('proj', 0, 'ws-1');

    const free = ctx.stores.clones.findFree('proj');
    expect(free).not.toBeNull();
    expect(free!.cloneIndex).toBe(1);
  });

  test('findFree returns null when all locked', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.lock('proj', 0, 'ws-1');
    expect(ctx.stores.clones.findFree('proj')).toBeNull();
  });

  test('findFree returns null when no clones', () => {
    expect(ctx.stores.clones.findFree('proj')).toBeNull();
  });

  test('nextIndex with no clones returns 0', () => {
    expect(ctx.stores.clones.nextIndex('proj')).toBe(0);
  });

  test('nextIndex with existing clones', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.add('proj', 1, 'main');
    expect(ctx.stores.clones.nextIndex('proj')).toBe(2);
  });

  test('nextIndex with gaps', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.add('proj', 5, 'main');
    expect(ctx.stores.clones.nextIndex('proj')).toBe(6);
  });

  test('remove clone', () => {
    ctx.stores.clones.add('proj', 0, 'main');
    ctx.stores.clones.remove('proj', 0);
    expect(ctx.stores.clones.get('proj', 0)).toBeNull();
    expect(ctx.stores.clones.getAll('proj').length).toBe(0);
  });

  test('getAll returns empty for unknown project', () => {
    expect(ctx.stores.clones.getAll('nonexistent').length).toBe(0);
  });
});
