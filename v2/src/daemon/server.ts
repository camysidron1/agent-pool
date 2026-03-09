import { createServer, type Server, type Socket } from "net";
import { writeFile, unlink, readFile } from "fs/promises";
import { join } from "path";
import {
  parseMessage,
  serializeMessage,
  createResponse,
  isRequest,
  type DaemonRequest,
} from "./protocol";
import type { TaskStore } from "../stores/interfaces";
import { Watchdog } from "../runner/watchdog";

export interface DaemonServerOptions {
  dataDir: string;
  taskStore: TaskStore;
  idleTimeoutMs?: number; // auto-stop after no runners connected (default 5 min)
}

/**
 * Daemon server: accepts Unix socket connections from runners and CLI.
 * Routes task operations through the shared TaskStore.
 * Pushes tasks to runners that have sent `runner.ready`.
 */
export class DaemonServer {
  private options: DaemonServerOptions;
  private server: Server | null = null;
  private clients = new Set<Socket>();
  private readyRunners: Socket[] = [];
  private watchdog: Watchdog;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private idleTimeoutMs: number;
  private startedAt: Date | null = null;

  constructor(options: DaemonServerOptions) {
    this.options = options;
    this.idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60 * 1000;
    this.watchdog = new Watchdog(
      {
        dataDir: options.dataDir,
        staleThresholdMs: 5 * 60 * 1000,
        scanIntervalMs: 30 * 1000,
      },
      options.taskStore
    );
  }

  get socketPath(): string {
    return join(this.options.dataDir, "apd.sock");
  }

  get pidPath(): string {
    return join(this.options.dataDir, "apd.pid");
  }

  get connectedClients(): number {
    return this.clients.size;
  }

  get uptime(): number {
    return this.startedAt ? Date.now() - this.startedAt.getTime() : 0;
  }

  /**
   * Start the daemon server on a Unix socket.
   */
  async start(): Promise<void> {
    // Clean up stale socket file
    try {
      await unlink(this.socketPath);
    } catch {
      // doesn't exist, fine
    }

    this.server = createServer((socket) => this.handleConnection(socket));

    await new Promise<void>((resolve, reject) => {
      this.server!.on("error", reject);
      this.server!.listen(this.socketPath, () => {
        this.server!.removeListener("error", reject);
        resolve();
      });
    });

    // Write PID file
    await writeFile(this.pidPath, String(process.pid));

    this.startedAt = new Date();
    this.watchdog.start();
    this.resetIdleTimer();

    // Signal handlers for graceful shutdown
    const shutdown = () => this.stop();
    process.on("SIGTERM", shutdown);
    process.on("SIGINT", shutdown);
  }

  /**
   * Stop the daemon server and clean up.
   */
  async stop(): Promise<void> {
    this.watchdog.stop();

    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }

    // Close all client connections
    for (const client of this.clients) {
      client.destroy();
    }
    this.clients.clear();
    this.readyRunners = [];

    // Close server
    if (this.server) {
      await new Promise<void>((resolve) => {
        this.server!.close(() => resolve());
      });
      this.server = null;
    }

    // Clean up files
    try {
      await unlink(this.socketPath);
    } catch {
      // already gone
    }
    try {
      await unlink(this.pidPath);
    } catch {
      // already gone
    }

    this.startedAt = null;
  }

  private handleConnection(socket: Socket): void {
    this.clients.add(socket);
    this.resetIdleTimer();

    let buffer = "";

    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      let newlineIdx: number;
      while ((newlineIdx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIdx);
        buffer = buffer.slice(newlineIdx + 1);
        this.handleLine(socket, line);
      }
    });

    socket.on("close", () => {
      this.clients.delete(socket);
      this.readyRunners = this.readyRunners.filter((s) => s !== socket);
      this.resetIdleTimer();
    });

    socket.on("error", () => {
      this.clients.delete(socket);
      this.readyRunners = this.readyRunners.filter((s) => s !== socket);
    });
  }

  private async handleLine(socket: Socket, line: string): Promise<void> {
    const msg = parseMessage(line);
    if (!msg || !isRequest(msg)) return;

    try {
      const result = await this.route(socket, msg);
      socket.write(serializeMessage(createResponse(msg.id, result)));
    } catch (err) {
      socket.write(
        serializeMessage(createResponse(msg.id, undefined, String(err)))
      );
    }
  }

  private async route(socket: Socket, req: DaemonRequest): Promise<any> {
    const { taskStore } = this.options;

    switch (req.method) {
      case "task.list":
        return await taskStore.list();

      case "task.add":
        return await taskStore.add(req.params);

      case "task.claim":
        return await taskStore.claim(req.params?.agentId);

      case "task.mark":
        await taskStore.update(req.params?.id, req.params?.fields);
        return { ok: true };

      case "runner.ready":
        this.readyRunners.push(socket);
        // Try to push a task immediately
        await this.pushTaskToRunner(socket, req.params?.agentId);
        return { ok: true };

      case "status":
        return {
          pid: process.pid,
          uptime: this.uptime,
          connectedClients: this.connectedClients,
          readyRunners: this.readyRunners.length,
        };

      case "shutdown":
        // Respond first, then stop
        setTimeout(() => this.stop(), 50);
        return { ok: true };

      default:
        throw new Error(`Unknown method: ${req.method}`);
    }
  }

  /**
   * Try to push an available task to a ready runner.
   */
  private async pushTaskToRunner(
    socket: Socket,
    agentId?: string
  ): Promise<void> {
    if (!agentId) return;

    const task = await this.options.taskStore.claim(agentId);
    if (task) {
      // Send pushed task assignment as a response-like notification
      socket.write(
        serializeMessage({
          id: "push",
          result: { type: "task.assigned", task },
        })
      );
      // Remove from ready queue since they now have work
      this.readyRunners = this.readyRunners.filter((s) => s !== socket);
    }
  }

  /**
   * Notify all ready runners that new tasks may be available.
   * Called when a task is added.
   */
  async notifyRunners(): Promise<void> {
    const runners = [...this.readyRunners];
    for (const socket of runners) {
      // We don't have the agentId here, so just send a nudge
      socket.write(
        serializeMessage({
          id: "push",
          result: { type: "task.available" },
        })
      );
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    // Only auto-stop if no clients connected
    if (this.clients.size === 0) {
      this.idleTimer = setTimeout(() => {
        this.stop();
      }, this.idleTimeoutMs);
    }
  }

  /**
   * Read the PID from a daemon PID file.
   */
  static async readPid(dataDir: string): Promise<number | null> {
    try {
      const raw = await readFile(join(dataDir, "apd.pid"), "utf-8");
      const pid = parseInt(raw.trim(), 10);
      return isNaN(pid) ? null : pid;
    } catch {
      return null;
    }
  }
}
