import type { CloneStore, Clone } from '../stores/interfaces.js';
import type { GitClient } from '../git/interfaces.js';
import type { CmuxClient } from '../cmux/interfaces.js';

export class PoolService {
  constructor(
    private store: CloneStore,
    private git: GitClient,
    private cmux: CmuxClient,
  ) {}

  async createClone(
    projectName: string,
    source: string,
    branch: string,
    prefix: string,
    dataDir: string,
    setup?: string | null,
  ): Promise<Clone> {
    const index = this.store.nextIndex(projectName);
    const clonePath = `${dataDir}/${prefix}-${String(index).padStart(2, '0')}`;

    await this.git.clone(source, clonePath, { noCheckout: true });

    // Set remote URL so origin points to GitHub, not local
    const remoteUrl = await this.git.getRemoteUrl(source);
    if (remoteUrl) {
      await this.git.setRemoteUrl(clonePath, remoteUrl);
    }

    await this.git.checkout(clonePath, branch);
    this.store.add(projectName, index, branch);

    return this.store.get(projectName, index)!;
  }

  list(projectName: string): Clone[] {
    return this.store.getAll(projectName);
  }

  lock(projectName: string, index: number, workspaceId: string): void {
    this.store.lock(projectName, index, workspaceId);
  }

  unlock(projectName: string, index: number): void {
    this.store.unlock(projectName, index);
  }

  findFree(projectName: string): Clone | null {
    return this.store.findFree(projectName);
  }

  async cleanupStaleLocks(projectName: string): Promise<void> {
    const clones = this.store.getAll(projectName);
    const activeWorkspaces = await this.cmux.listWorkspaces();
    const activeSet = new Set(activeWorkspaces);

    for (const clone of clones) {
      if (clone.locked && clone.workspaceId.startsWith('workspace:')) {
        if (!activeSet.has(clone.workspaceId)) {
          this.store.unlock(projectName, clone.cloneIndex);
        }
      }
    }
  }

  removeClone(projectName: string, index: number): void {
    this.store.remove(projectName, index);
  }

  async refreshClone(projectName: string, index: number, branch: string, dataDir: string, prefix: string): Promise<void> {
    const clonePath = this.getClonePath(prefix, index, dataDir);
    await this.git.fetch(clonePath);
    await this.git.checkout(clonePath, branch);
    await this.git.resetHard(clonePath, `origin/${branch}`);
    await this.git.clean(clonePath);
    await this.git.deleteBranches(clonePath, /^agent-/);
    this.store.unlock(projectName, index);
  }

  getClonePath(prefix: string, index: number, dataDir: string): string {
    return `${dataDir}/${prefix}-${String(index).padStart(2, '0')}`;
  }

  removeAllClones(projectName: string): void {
    const clones = this.store.getAll(projectName);
    for (const clone of clones) {
      this.store.remove(projectName, clone.cloneIndex);
    }
  }
}
