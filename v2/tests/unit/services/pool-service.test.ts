import { describe, test, expect, beforeEach } from 'bun:test';
import { PoolService } from '../../../src/services/pool-service.js';
import { MockGitClient } from '../../../src/git/mock.js';
import { MockCmuxClient } from '../../../src/cmux/mock.js';
import type { CloneStore, Clone } from '../../../src/stores/interfaces.js';

class MockCloneStore implements CloneStore {
  clones: Clone[] = [];
  private indexCounter: Map<string, number> = new Map();

  getAll(projectName: string): Clone[] {
    return this.clones.filter(c => c.projectName === projectName);
  }

  get(projectName: string, index: number): Clone | null {
    return this.clones.find(c => c.projectName === projectName && c.cloneIndex === index) ?? null;
  }

  add(projectName: string, index: number, branch: string): void {
    this.clones.push({
      id: this.clones.length + 1,
      projectName,
      cloneIndex: index,
      locked: false,
      workspaceId: '',
      lockedAt: null,
      branch,
    });
  }

  remove(projectName: string, index: number): void {
    this.clones = this.clones.filter(c => !(c.projectName === projectName && c.cloneIndex === index));
  }

  lock(projectName: string, index: number, workspaceId: string): void {
    const clone = this.get(projectName, index);
    if (clone) {
      clone.locked = true;
      clone.workspaceId = workspaceId;
      clone.lockedAt = new Date().toISOString();
    }
  }

  unlock(projectName: string, index: number): void {
    const clone = this.get(projectName, index);
    if (clone) {
      clone.locked = false;
      clone.workspaceId = '';
      clone.lockedAt = null;
    }
  }

  findFree(projectName: string): Clone | null {
    return this.clones.find(c => c.projectName === projectName && !c.locked) ?? null;
  }

  nextIndex(projectName: string): number {
    const current = this.indexCounter.get(projectName) ?? 0;
    const next = current + 1;
    this.indexCounter.set(projectName, next);
    return next;
  }
}

describe('PoolService', () => {
  let store: MockCloneStore;
  let git: MockGitClient;
  let cmux: MockCmuxClient;
  let service: PoolService;

  beforeEach(() => {
    store = new MockCloneStore();
    git = new MockGitClient();
    cmux = new MockCmuxClient();
    service = new PoolService(store, git, cmux);
  });

  describe('createClone', () => {
    test('calls git.clone, git.checkout, and store.add in order', async () => {
      git.remoteUrls.set('/src/repo', 'https://github.com/org/repo.git');

      const clone = await service.createClone('proj', '/src/repo', 'main', 'proj', '/data');

      // Verify git.clone was called with noCheckout
      const cloneCall = git.calls.find(c => c.method === 'clone');
      expect(cloneCall).toBeDefined();
      expect(cloneCall!.args[0]).toBe('/src/repo');
      expect(cloneCall!.args[1]).toBe('/data/proj-01');
      expect(cloneCall!.args[2]).toEqual({ noCheckout: true });

      // Verify remote URL was fetched and set
      const getRemote = git.calls.find(c => c.method === 'getRemoteUrl');
      expect(getRemote).toBeDefined();
      const setRemote = git.calls.find(c => c.method === 'setRemoteUrl');
      expect(setRemote).toBeDefined();
      expect(setRemote!.args[1]).toBe('https://github.com/org/repo.git');

      // Verify checkout
      const checkoutCall = git.calls.find(c => c.method === 'checkout');
      expect(checkoutCall).toBeDefined();
      expect(checkoutCall!.args).toEqual(['/data/proj-01', 'main']);

      // Verify clone was added to store
      expect(store.clones).toHaveLength(1);
      expect(clone.cloneIndex).toBe(1);
      expect(clone.branch).toBe('main');
    });

    test('skips setRemoteUrl when source has no remote', async () => {
      const clone = await service.createClone('proj', '/local/repo', 'dev', 'proj', '/data');

      const setRemote = git.calls.find(c => c.method === 'setRemoteUrl');
      expect(setRemote).toBeUndefined();
      expect(clone).toBeDefined();
    });

    test('uses zero-padded index in path', async () => {
      await service.createClone('proj', '/src', 'main', 'proj', '/data');
      await service.createClone('proj', '/src', 'main', 'proj', '/data');

      const cloneCalls = git.calls.filter(c => c.method === 'clone');
      expect(cloneCalls[0].args[1]).toBe('/data/proj-01');
      expect(cloneCalls[1].args[1]).toBe('/data/proj-02');
    });
  });

  describe('list', () => {
    test('returns clones for project', () => {
      store.add('proj', 1, 'main');
      store.add('proj', 2, 'main');
      store.add('other', 1, 'main');

      expect(service.list('proj')).toHaveLength(2);
      expect(service.list('other')).toHaveLength(1);
    });
  });

  describe('findFree', () => {
    test('returns first unlocked clone', () => {
      store.add('proj', 1, 'main');
      store.lock('proj', 1, 'ws1');
      store.add('proj', 2, 'main');

      const free = service.findFree('proj');
      expect(free).not.toBeNull();
      expect(free!.cloneIndex).toBe(2);
    });

    test('returns null when all locked', () => {
      store.add('proj', 1, 'main');
      store.lock('proj', 1, 'ws1');

      expect(service.findFree('proj')).toBeNull();
    });
  });

  describe('lock / unlock', () => {
    test('locks a clone with workspace id', () => {
      store.add('proj', 1, 'main');
      service.lock('proj', 1, 'workspace:abc');

      const clone = store.get('proj', 1)!;
      expect(clone.locked).toBe(true);
      expect(clone.workspaceId).toBe('workspace:abc');
    });

    test('unlocks a clone', () => {
      store.add('proj', 1, 'main');
      service.lock('proj', 1, 'workspace:abc');
      service.unlock('proj', 1);

      const clone = store.get('proj', 1)!;
      expect(clone.locked).toBe(false);
    });
  });

  describe('cleanupStaleLocks', () => {
    test('unlocks clones whose workspaces no longer exist', async () => {
      store.add('proj', 1, 'main');
      store.add('proj', 2, 'main');
      store.lock('proj', 1, 'workspace:alive');
      store.lock('proj', 2, 'workspace:dead');

      cmux.workspaces = ['workspace:alive'];

      await service.cleanupStaleLocks('proj');

      expect(store.get('proj', 1)!.locked).toBe(true);
      expect(store.get('proj', 2)!.locked).toBe(false);
    });

    test('ignores non-workspace locks', async () => {
      store.add('proj', 1, 'main');
      store.lock('proj', 1, 'manual-lock');

      cmux.workspaces = [];

      await service.cleanupStaleLocks('proj');

      // Should remain locked because it doesn't start with "workspace:"
      expect(store.get('proj', 1)!.locked).toBe(true);
    });

    test('does nothing when no clones are locked', async () => {
      store.add('proj', 1, 'main');

      await service.cleanupStaleLocks('proj');

      expect(store.get('proj', 1)!.locked).toBe(false);
    });
  });

  describe('removeClone', () => {
    test('removes a clone from the store', () => {
      store.add('proj', 1, 'main');
      service.removeClone('proj', 1);
      expect(store.clones).toHaveLength(0);
    });
  });
});
