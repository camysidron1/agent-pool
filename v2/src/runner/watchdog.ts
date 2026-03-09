import { readdir, readFile, unlink, mkdir } from "fs/promises";
import { join } from "path";
import type { TaskStore } from "../stores/interfaces.js";

export interface HeartbeatData {
  timestamp: string;
  pid: number;
  task_id: string;
  last_tool: string;
}

export interface StuckAgent {
  agentId: string;
  taskId: string;
  reason: "stale_heartbeat" | "dead_pid";
  lastHeartbeat: string;
}

export interface WatchdogOptions {
  dataDir: string;
  staleThresholdMs?: number; // default 5 * 60 * 1000 (5 min)
  scanIntervalMs?: number; // default 30 * 1000 (30s)
}

export class Watchdog {
  private dataDir: string;
  private staleThresholdMs: number;
  private scanIntervalMs: number;
  private intervalId: ReturnType<typeof setInterval> | null = null;
  private taskStore: TaskStore | null;
  private logger: (msg: string) => void;

  constructor(
    options: WatchdogOptions,
    taskStore: TaskStore | null = null,
    logger: (msg: string) => void = console.warn
  ) {
    this.dataDir = options.dataDir;
    this.staleThresholdMs = options.staleThresholdMs ?? 5 * 60 * 1000;
    this.scanIntervalMs = options.scanIntervalMs ?? 30 * 1000;
    this.taskStore = taskStore;
    this.logger = logger;
  }

  get heartbeatDir(): string {
    return join(this.dataDir, "heartbeats");
  }

  /**
   * Start the periodic scan loop.
   */
  start(): void {
    if (this.intervalId) return;
    this.intervalId = setInterval(async () => {
      try {
        const stuck = await this.scan();
        await this.handleStuckAgents(stuck);
      } catch (err) {
        this.logger(`Watchdog scan error: ${err}`);
      }
    }, this.scanIntervalMs);
  }

  /**
   * Stop the periodic scan loop.
   */
  stop(): void {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  /**
   * Perform a single scan pass. Returns list of stuck agents.
   */
  async scan(): Promise<StuckAgent[]> {
    const dir = this.heartbeatDir;
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return []; // heartbeat dir doesn't exist yet
    }

    const stuck: StuckAgent[] = [];
    const now = Date.now();

    for (const file of files) {
      if (!file.endsWith(".json")) continue;

      const agentId = file.replace(/\.json$/, "");
      const filePath = join(dir, file);

      let data: HeartbeatData;
      try {
        const raw = await readFile(filePath, "utf-8");
        data = JSON.parse(raw);
      } catch {
        continue; // corrupted file, skip
      }

      const heartbeatAge = now - new Date(data.timestamp).getTime();
      const pidAlive = await this.isPidAlive(data.pid);

      if (!pidAlive) {
        stuck.push({
          agentId,
          taskId: data.task_id,
          reason: "dead_pid",
          lastHeartbeat: data.timestamp,
        });
      } else if (heartbeatAge > this.staleThresholdMs) {
        stuck.push({
          agentId,
          taskId: data.task_id,
          reason: "stale_heartbeat",
          lastHeartbeat: data.timestamp,
        });
      }
    }

    return stuck;
  }

  /**
   * Handle stuck agents: mark tasks blocked and clean up heartbeat files.
   */
  private async handleStuckAgents(stuck: StuckAgent[]): Promise<void> {
    for (const agent of stuck) {
      this.logger(
        `Watchdog: agent ${agent.agentId} stuck (${agent.reason}), task ${agent.taskId}`
      );

      if (this.taskStore) {
        try {
          this.taskStore.mark(agent.taskId, 'blocked', {
            result: `Watchdog: ${agent.reason} at ${agent.lastHeartbeat}`,
          });
        } catch (err) {
          this.logger(`Failed to mark task ${agent.taskId} blocked: ${err}`);
        }
      }

      try {
        await unlink(join(this.heartbeatDir, `${agent.agentId}.json`));
      } catch {
        // already cleaned up
      }
    }
  }

  /**
   * Check if a PID is alive using kill -0.
   */
  private async isPidAlive(pid: number): Promise<boolean> {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Write a heartbeat file for an agent.
   */
  static async writeHeartbeat(
    dataDir: string,
    agentId: string,
    taskId: string,
    lastTool: string = ""
  ): Promise<void> {
    const dir = join(dataDir, "heartbeats");
    await mkdir(dir, { recursive: true });
    const data: HeartbeatData = {
      timestamp: new Date().toISOString(),
      pid: process.pid,
      task_id: taskId,
      last_tool: lastTool,
    };
    await Bun.write(join(dir, `${agentId}.json`), JSON.stringify(data));
  }

  /**
   * Remove a heartbeat file for an agent.
   */
  static async clearHeartbeat(
    dataDir: string,
    agentId: string
  ): Promise<void> {
    try {
      await unlink(join(dataDir, "heartbeats", `${agentId}.json`));
    } catch {
      // file doesn't exist, fine
    }
  }
}
