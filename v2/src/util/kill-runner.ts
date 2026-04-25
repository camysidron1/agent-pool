import { readFile } from 'fs/promises';
import { join } from 'path';

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Kill a runner process by reading its PID from the heartbeat file.
 * Sends SIGTERM first, waits, then SIGKILL if still alive.
 * Returns true if a process was found and killed.
 */
export async function killRunnerByHeartbeat(dataDir: string, agentId: string): Promise<boolean> {
  try {
    const hbPath = join(dataDir, 'heartbeats', `${agentId}.json`);
    const data = JSON.parse(await readFile(hbPath, 'utf-8'));
    const pid = data.pid;
    if (!pid) return false;

    try {
      process.kill(pid, 0); // check if alive
    } catch {
      return false; // already dead
    }

    // Kill the process group (negative PID) to get both runner and child claude
    try { process.kill(-pid, 'SIGTERM'); } catch { process.kill(pid, 'SIGTERM'); }
    await sleep(1000);

    // Check if still alive
    try {
      process.kill(pid, 0);
      // Still alive — force kill
      try { process.kill(-pid, 'SIGKILL'); } catch { process.kill(pid, 'SIGKILL'); }
      await sleep(300);
    } catch {
      // Dead, good
    }
    return true;
  } catch {
    return false;
  }
}
