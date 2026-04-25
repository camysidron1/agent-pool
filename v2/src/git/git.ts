import type { GitClient } from './interfaces.js';

async function run(args: string[], cwd?: string): Promise<string> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
    cwd,
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  if (exitCode !== 0) {
    throw new Error(`git command failed (exit ${exitCode}): ${args.join(' ')}\n${stderr}`);
  }
  return stdout.trim();
}

export class RealGitClient implements GitClient {
  async clone(source: string, dest: string, opts?: { branch?: string; noCheckout?: boolean }): Promise<void> {
    const args = ['git', 'clone', '--local'];
    if (opts?.noCheckout) args.push('--no-checkout');
    if (opts?.branch) args.push('--branch', opts.branch);
    args.push('-q', source, dest);
    await run(args);
  }

  async checkout(repoPath: string, branch: string): Promise<void> {
    await run(['git', '-C', repoPath, 'checkout', branch, '-q']);
  }

  async fetch(repoPath: string): Promise<void> {
    await run(['git', '-C', repoPath, 'fetch', 'origin', '-q']);
  }

  async getRemoteUrl(repoPath: string, remote?: string): Promise<string | null> {
    try {
      return await run(['git', '-C', repoPath, 'remote', 'get-url', remote ?? 'origin']);
    } catch {
      return null;
    }
  }

  async setRemoteUrl(repoPath: string, url: string, remote?: string): Promise<void> {
    await run(['git', '-C', repoPath, 'remote', 'set-url', remote ?? 'origin', url]);
  }

  async getCurrentBranch(repoPath: string): Promise<string> {
    return await run(['git', '-C', repoPath, 'rev-parse', '--abbrev-ref', 'HEAD']);
  }

  async resetHard(repoPath: string, ref: string): Promise<void> {
    await run(['git', '-C', repoPath, 'reset', '--hard', ref, '-q']);
  }

  async clean(repoPath: string): Promise<void> {
    await run(['git', '-C', repoPath, 'clean', '-fdx', '-q']);
  }

  async deleteBranches(repoPath: string, pattern: RegExp): Promise<void> {
    const output = await run(['git', '-C', repoPath, 'branch', '--list']);
    const branches = output.split('\n')
      .map(b => b.replace(/^\*?\s+/, '').trim())
      .filter(b => b && pattern.test(b));
    for (const branch of branches) {
      await run(['git', '-C', repoPath, 'branch', '-D', branch]);
    }
  }

  async createBranch(repoPath: string, branch: string, startPoint?: string): Promise<void> {
    // Delete existing branch if it exists (from a previous run/retry)
    try {
      await run(['git', '-C', repoPath, 'branch', '-D', branch]);
    } catch {
      // Branch doesn't exist, fine
    }
    const args = ['git', '-C', repoPath, 'checkout', '-b', branch];
    if (startPoint) args.push(startPoint);
    await run(args);
  }

  async worktreeAdd(
    repoPath: string,
    worktreePath: string,
    branch: string,
    startPoint: string,
  ): Promise<void> {
    // If a worktree already exists at this path, reset it to startPoint
    // on the same branch — keeps `agent-pool start` cheap to re-run.
    const existingList = await run(['git', '-C', repoPath, 'worktree', 'list', '--porcelain']);
    const alreadyAtPath = existingList.split('\n\n').some((entry) =>
      entry.split('\n').some((line) => line === `worktree ${worktreePath}`),
    );

    if (alreadyAtPath) {
      // Reuse: ensure on the right branch, hard reset to startPoint, clean.
      try {
        await run(['git', '-C', worktreePath, 'checkout', '-B', branch, startPoint, '-q']);
      } catch {
        // Fall through to recreate if checkout fails (e.g. corrupted state).
        await this.worktreeRemove(repoPath, worktreePath);
      }
      try {
        await run(['git', '-C', worktreePath, 'reset', '--hard', startPoint, '-q']);
        await run(['git', '-C', worktreePath, 'clean', '-fd', '-q']);
        return;
      } catch {
        await this.worktreeRemove(repoPath, worktreePath);
      }
    }

    // -B creates or resets <branch> at <startPoint>; --force lets us reuse
    // a branch that may already exist from a prior run.
    await run([
      'git', '-C', repoPath, 'worktree', 'add',
      '--force', '-B', branch, worktreePath, startPoint,
    ]);
  }

  async worktreeRemove(repoPath: string, worktreePath: string): Promise<void> {
    try {
      await run(['git', '-C', repoPath, 'worktree', 'remove', '--force', worktreePath]);
    } catch {
      // Worktree may already be gone; prune metadata so the next add succeeds.
      try {
        await run(['git', '-C', repoPath, 'worktree', 'prune']);
      } catch { /* best-effort */ }
    }
  }
}
