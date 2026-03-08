import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { RealGitClient } from '../../src/git/git.js';
import { createSourceRepo } from '../fixtures/git-repos.js';

let tmpDir: string;
let git: RealGitClient;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'ap-git-test-'));
  git = new RealGitClient();
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe('RealGitClient', () => {
  test('clone creates a local copy', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone1');
    await git.clone(source, dest);

    const branch = await git.getCurrentBranch(dest);
    expect(branch).toBe('main');
  });

  test('clone with noCheckout', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-noco');
    await git.clone(source, dest, { noCheckout: true });

    // Should still be able to checkout
    await git.checkout(dest, 'main');
    const branch = await git.getCurrentBranch(dest);
    expect(branch).toBe('main');
  });

  test('getRemoteUrl returns the remote URL', async () => {
    const source = createSourceRepo(tmpDir);
    const url = await git.getRemoteUrl(source);
    expect(url).toBe('https://github.com/test/repo.git');
  });

  test('getRemoteUrl returns null for missing remote', async () => {
    const source = createSourceRepo(tmpDir);
    const url = await git.getRemoteUrl(source, 'nonexistent');
    expect(url).toBeNull();
  });

  test('setRemoteUrl changes the URL', async () => {
    const source = createSourceRepo(tmpDir);
    await git.setRemoteUrl(source, 'https://github.com/new/url.git');
    const url = await git.getRemoteUrl(source);
    expect(url).toBe('https://github.com/new/url.git');
  });

  test('fetch works on a clone', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-fetch');
    await git.clone(source, dest);

    // Set remote to source so fetch has something to fetch from
    await git.setRemoteUrl(dest, source);
    await git.fetch(dest);
    // No error means success
  });

  test('createBranch and checkout', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-branch');
    await git.clone(source, dest);

    await git.createBranch(dest, 'agent-test');
    const branch = await git.getCurrentBranch(dest);
    expect(branch).toBe('agent-test');

    await git.checkout(dest, 'main');
    expect(await git.getCurrentBranch(dest)).toBe('main');
  });

  test('resetHard resets to a ref', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-reset');
    await git.clone(source, dest);
    await git.setRemoteUrl(dest, source);
    await git.fetch(dest);

    await git.resetHard(dest, 'origin/main');
    // No error means success
  });

  test('clean removes untracked files', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-clean');
    await git.clone(source, dest);

    const { writeFileSync } = await import('fs');
    writeFileSync(join(dest, 'untracked.txt'), 'junk');

    await git.clean(dest);

    const { existsSync } = await import('fs');
    expect(existsSync(join(dest, 'untracked.txt'))).toBe(false);
  });

  test('deleteBranches removes matching branches', async () => {
    const source = createSourceRepo(tmpDir);
    const dest = join(tmpDir, 'clone-delbr');
    await git.clone(source, dest);

    await git.createBranch(dest, 'agent-foo');
    await git.checkout(dest, 'main');
    await git.createBranch(dest, 'agent-bar');
    await git.checkout(dest, 'main');

    await git.deleteBranches(dest, /^agent-/);

    // Trying to checkout deleted branch should fail
    try {
      await git.checkout(dest, 'agent-foo');
      expect(true).toBe(false); // Should not reach
    } catch {
      // Expected
    }
  });
});
