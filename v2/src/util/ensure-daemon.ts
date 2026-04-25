import { spawn } from 'child_process';
import { join } from 'path';
import { DaemonClient } from '../daemon/client.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function isDaemonRunning(socketPath: string): Promise<boolean> {
  const client = new DaemonClient({ socketPath, timeoutMs: 1000 });
  const connected = await client.connect();
  if (connected) client.close();
  return connected;
}

/**
 * Ensure daemon is running for the current AGENT_POOL_DATA_DIR.
 * Returns true if running (already running or started successfully).
 */
export async function ensureDaemonRunning(dataDir: string, toolDir: string): Promise<boolean> {
  const socketPath = join(dataDir, 'apd.sock');
  if (await isDaemonRunning(socketPath)) return true;

  try {
    const child = spawn('bun', ['run', join(toolDir, 'v2/src/index.ts'), 'daemon', 'start'], {
      detached: true,
      stdio: 'ignore',
      env: {
        ...process.env,
        AGENT_POOL_DATA_DIR: dataDir,
        AGENT_POOL_TOOL_DIR: toolDir,
      },
    });
    child.unref();
  } catch {
    return false;
  }

  // Wait briefly for socket readiness.
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    await sleep(200);
    if (await isDaemonRunning(socketPath)) return true;
  }
  return false;
}
