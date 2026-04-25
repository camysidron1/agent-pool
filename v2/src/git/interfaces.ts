export interface GitClient {
  clone(source: string, dest: string, opts?: { branch?: string; noCheckout?: boolean }): Promise<void>;
  checkout(repoPath: string, branch: string): Promise<void>;
  fetch(repoPath: string): Promise<void>;
  getRemoteUrl(repoPath: string, remote?: string): Promise<string | null>;
  setRemoteUrl(repoPath: string, url: string, remote?: string): Promise<void>;
  getCurrentBranch(repoPath: string): Promise<string>;
  resetHard(repoPath: string, ref: string): Promise<void>;
  clean(repoPath: string): Promise<void>;
  deleteBranches(repoPath: string, pattern: RegExp): Promise<void>;
  createBranch(repoPath: string, branch: string, startPoint?: string): Promise<void>;

  /**
   * Add (or reset) a worktree at `worktreePath` checked out on `branch`,
   * created from `startPoint`. Idempotent — if the worktree already exists
   * at that path it is reset to startPoint on the same branch.
   */
  worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
  ): Promise<void>;

  /** Remove a worktree at `worktreePath`. No-op if it doesn't exist. */
  worktreeRemove(repoPath: string, worktreePath: string): Promise<void>;
}
