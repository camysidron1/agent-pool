import { DaemonServer } from "../daemon/server";
import { DaemonClient } from "../daemon/client";
import { startDaemon } from "../daemon/index";
import type { TaskStore } from "../stores/interfaces";
import { join } from "path";

export interface DaemonCommandOptions {
  dataDir: string;
  taskStore: TaskStore;
}

/**
 * `agent-pool daemon start` — start daemon in foreground.
 */
export async function daemonStart(
  options: DaemonCommandOptions
): Promise<DaemonServer> {
  return startDaemon({
    dataDir: options.dataDir,
    taskStore: options.taskStore,
  });
}

/**
 * `agent-pool daemon stop` — send shutdown to running daemon or kill PID.
 */
export async function daemonStop(dataDir: string): Promise<boolean> {
  const socketPath = join(dataDir, "apd.sock");

  // Try graceful shutdown via socket
  const client = new DaemonClient({ socketPath, timeoutMs: 3000 });
  const connected = await client.connect();
  if (connected) {
    try {
      await client.request("shutdown");
      client.close();
      return true;
    } catch {
      client.close();
    }
  }

  // Fall back to killing the PID
  const pid = await DaemonServer.readPid(dataDir);
  if (pid) {
    try {
      process.kill(pid, "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  return false;
}

/**
 * `agent-pool daemon status` — show daemon status.
 */
export async function daemonStatus(
  dataDir: string
): Promise<{
  running: boolean;
  pid?: number;
  uptime?: number;
  connectedClients?: number;
  readyRunners?: number;
}> {
  const socketPath = join(dataDir, "apd.sock");

  const client = new DaemonClient({ socketPath, timeoutMs: 3000 });
  const connected = await client.connect();
  if (connected) {
    try {
      const resp = await client.request("status");
      client.close();
      if (resp.result) {
        return { running: true, ...resp.result };
      }
    } catch {
      client.close();
    }
  }

  // Check PID file
  const pid = await DaemonServer.readPid(dataDir);
  if (pid) {
    try {
      process.kill(pid, 0);
      return { running: true, pid };
    } catch {
      return { running: false };
    }
  }

  return { running: false };
}
