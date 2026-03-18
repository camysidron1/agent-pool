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
}
