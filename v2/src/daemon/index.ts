import { DaemonServer } from "./server";
import type { TaskStore, Task } from "../stores/interfaces";

/**
 * Standalone daemon entrypoint.
 * Usage: bun run v2/src/daemon/index.ts <dataDir>
 *
 * Creates a minimal TaskStore from the data directory and starts the daemon.
 * In production, the TaskStore would be backed by SQLite; here we accept
 * it as a dependency for flexibility.
 */

export interface DaemonEntrypointOptions {
  dataDir: string;
  taskStore: TaskStore;
  idleTimeoutMs?: number;
}

export async function startDaemon(
  options: DaemonEntrypointOptions
): Promise<DaemonServer> {
  const server = new DaemonServer({
    dataDir: options.dataDir,
    taskStore: options.taskStore,
    idleTimeoutMs: options.idleTimeoutMs,
  });

  await server.start();
  console.log(`Daemon started (pid=${process.pid}, socket=${server.socketPath})`);

  return server;
}

export { DaemonServer } from "./server";
export { DaemonClient } from "./client";
export {
  serializeMessage,
  parseMessage,
  createRequest,
  createResponse,
  isRequest,
  isResponse,
} from "./protocol";
export type {
  DaemonRequest,
  DaemonResponse,
  DaemonMessage,
} from "./protocol";
export type { DaemonClientOptions } from "./client";
export type { DaemonServerOptions } from "./server";
