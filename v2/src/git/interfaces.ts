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
}
