import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';

function git(args: string[], cwd: string): void {
  const result = spawnSync('git', args, { cwd, stdio: 'pipe' });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr?.toString()}`);
  }
}

export function createBareRepo(dir: string): string {
  const repoPath = join(dir, 'bare.git');
  mkdirSync(repoPath, { recursive: true });
  git(['init', '--bare'], repoPath);
  return repoPath;
}

export function createSourceRepo(dir: string): string {
  const repoPath = join(dir, 'source');
  mkdirSync(repoPath, { recursive: true });
  git(['init'], repoPath);
  git(['config', 'user.email', 'test@test.com'], repoPath);
  git(['config', 'user.name', 'Test'], repoPath);

  writeFileSync(join(repoPath, 'README.md'), '# Test\n');
  git(['add', '.'], repoPath);
  git(['commit', '-m', 'initial'], repoPath);

  // Set a fake origin remote
  git(['remote', 'add', 'origin', 'https://github.com/test/repo.git'], repoPath);

  return repoPath;
}
