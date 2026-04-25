import { join } from 'path';
import { DaemonClient } from '../daemon/client.js';

/**
 * Best-effort, fire-and-forget notification to the daemon that new tasks
 * are available. If the daemon isn't running, this silently does nothing.
 */
export function notifyDaemon(dataDir: string, workspaceRef?: string): void {
  const socketPath = join(dataDir, 'apd.sock');
  const client = new DaemonClient({ socketPath, timeoutMs: 1000 });
  client.connect().then(async (connected) => {
    if (connected) {
      try { await client.request('task.notify', workspaceRef ? { workspaceRef } : undefined); } catch {}
      client.close();
    }
  });
}
