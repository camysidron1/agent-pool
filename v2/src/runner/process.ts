// Typed Bun.spawn wrappers

export interface SpawnResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Run a command and capture output */
export async function exec(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<SpawnResult> {
  const proc = Bun.spawn(args, {
    cwd: opts?.cwd,
    env: opts?.env,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  return { exitCode, stdout, stderr };
}

/** Run a command, throw if non-zero exit */
export async function execOrThrow(
  args: string[],
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<SpawnResult> {
  const result = await exec(args, opts);
  if (result.exitCode !== 0) {
    throw new Error(
      `Command failed (${result.exitCode}): ${args.join(' ')}\n${result.stderr}`,
    );
  }
  return result;
}
