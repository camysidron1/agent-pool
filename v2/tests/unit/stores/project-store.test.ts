import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { createTestContext, type TestContext } from '../../fixtures/context.js';

describe('SqliteProjectStore', () => {
  let ctx: TestContext;

  beforeEach(() => {
    ctx = createTestContext();
  });

  afterEach(() => {
    ctx.cleanup();
  });

  const { stores } = {} as TestContext; // just for type; we use ctx in tests

  test('add project and verify fields', () => {
    ctx.stores.projects.add({ name: 'myproj', source: '/tmp/src' });
    const proj = ctx.stores.projects.get('myproj');
    expect(proj).not.toBeNull();
    expect(proj!.name).toBe('myproj');
    expect(proj!.source).toBe('/tmp/src');
    expect(proj!.prefix).toBe('myproj'); // defaults to name
    expect(proj!.branch).toBe('main');   // defaults to main
    expect(proj!.setup).toBeNull();
  });

  test('add project with custom prefix and branch', () => {
    ctx.stores.projects.add({ name: 'proj', source: '/src', prefix: 'pp', branch: 'develop' });
    const proj = ctx.stores.projects.get('proj')!;
    expect(proj.prefix).toBe('pp');
    expect(proj.branch).toBe('develop');
  });

  test('first project becomes default', () => {
    ctx.stores.projects.add({ name: 'first', source: '/src' });
    const proj = ctx.stores.projects.get('first')!;
    expect(proj.isDefault).toBe(true);
  });

  test('second project does NOT become default', () => {
    ctx.stores.projects.add({ name: 'first', source: '/src' });
    ctx.stores.projects.add({ name: 'second', source: '/src2' });
    const second = ctx.stores.projects.get('second')!;
    expect(second.isDefault).toBe(false);
  });

  test('getAll returns all projects', () => {
    ctx.stores.projects.add({ name: 'a', source: '/a' });
    ctx.stores.projects.add({ name: 'b', source: '/b' });
    const all = ctx.stores.projects.getAll();
    expect(all.length).toBe(2);
  });

  test('get returns null for missing project', () => {
    expect(ctx.stores.projects.get('nope')).toBeNull();
  });

  test('getDefault returns the default project', () => {
    ctx.stores.projects.add({ name: 'a', source: '/a' });
    ctx.stores.projects.add({ name: 'b', source: '/b' });
    const def = ctx.stores.projects.getDefault();
    expect(def).not.toBeNull();
    expect(def!.name).toBe('a');
  });

  test('getDefault returns null when no projects', () => {
    expect(ctx.stores.projects.getDefault()).toBeNull();
  });

  test('setDefault changes the default', () => {
    ctx.stores.projects.add({ name: 'a', source: '/a' });
    ctx.stores.projects.add({ name: 'b', source: '/b' });
    ctx.stores.projects.setDefault('b');
    const def = ctx.stores.projects.getDefault()!;
    expect(def.name).toBe('b');
    // old default is cleared
    const a = ctx.stores.projects.get('a')!;
    expect(a.isDefault).toBe(false);
  });

  test('remove project', () => {
    ctx.stores.projects.add({ name: 'a', source: '/a' });
    ctx.stores.projects.remove('a');
    expect(ctx.stores.projects.get('a')).toBeNull();
    expect(ctx.stores.projects.getAll().length).toBe(0);
  });

  test('remove default project clears default', () => {
    ctx.stores.projects.add({ name: 'a', source: '/a' });
    ctx.stores.projects.add({ name: 'b', source: '/b' });
    ctx.stores.projects.remove('a');
    // default should be gone, not auto-assigned
    expect(ctx.stores.projects.getDefault()).toBeNull();
  });

  test('update partial fields', () => {
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
    ctx.stores.projects.update('proj', { source: '/new-src', trackingType: 'linear' });
    const proj = ctx.stores.projects.get('proj')!;
    expect(proj.source).toBe('/new-src');
    expect(proj.trackingType).toBe('linear');
    expect(proj.prefix).toBe('proj'); // unchanged
  });

  test('update boolean fields', () => {
    ctx.stores.projects.add({ name: 'proj', source: '/src' });
    ctx.stores.projects.update('proj', { workflowAutoMerge: true });
    const proj = ctx.stores.projects.get('proj')!;
    expect(proj.workflowAutoMerge).toBe(true);
  });
});
