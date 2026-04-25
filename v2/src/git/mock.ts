import type { GitClient } from './interfaces.js';

interface GitCall {
  method: string;
  args: unknown[];
}

export class MockGitClient implements GitClient {
  calls: GitCall[] = [];
  remoteUrls: Map<string, string> = new Map();
  branches: Map<string, string> = new Map();

  async clone(source: string, dest: string, opts?: { branch?: string; noCheckout?: boolean }): Promise<void> {
    this.calls.push({ method: 'clone', args: [source, dest, opts] });
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    this.calls.push({ method: 'checkout', args: [repoPath, branch] });
    this.branches.set(repoPath, branch);
  }

  async fetch(repoPath: string): Promise<void> {
    this.calls.push({ method: 'fetch', args: [repoPath] });
  }

  async getRemoteUrl(repoPath: string, remote?: string): Promise<string | null> {
    this.calls.push({ method: 'getRemoteUrl', args: [repoPath, remote] });
    return this.remoteUrls.get(repoPath) ?? null;
  }

  async setRemoteUrl(repoPath: string, url: string, remote?: string): Promise<void> {
    this.calls.push({ method: 'setRemoteUrl', args: [repoPath, url, remote] });
    this.remoteUrls.set(repoPath, url);
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    this.calls.push({ method: 'getCurrentBranch', args: [repoPath] });
    return this.branches.get(repoPath) ?? 'main';
  }

  async resetHard(repoPath: string, ref: string): Promise<void> {
    this.calls.push({ method: 'resetHard', args: [repoPath, ref] });
  }

  async clean(repoPath: string): Promise<void> {
    this.calls.push({ method: 'clean', args: [repoPath] });
  }

  async deleteBranches(repoPath: string, pattern: RegExp): Promise<void> {
    this.calls.push({ method: 'deleteBranches', args: [repoPath, pattern] });
  }

  async createBranch(repoPath: string, branch: string, startPoint?: string): Promise<void> {
    this.calls.push({ method: 'createBranch', args: [repoPath, branch, startPoint] });
    this.branches.set(repoPath, branch);
  }

  async worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    this.calls.push({ method: 'worktreeAdd', args: [repoPath, worktreePath, branch, startPoint] });
    this.branches.set(worktreePath, branch);
  }

  async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
    this.calls.push({ method: 'worktreeRemove', args: [repoPath, worktreePath] });
    this.branches.delete(worktreePath);
  }
}
