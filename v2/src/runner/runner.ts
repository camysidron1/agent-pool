import { Watchdog } from "./watchdog";
import { DaemonClient } from "../daemon/client";
import { parseMessage, serializeMessage, createRequest } from "../daemon/protocol";
import type { TaskStore, Task } from "../stores/interfaces";
import { join } from "path";

export interface RunnerOptions {
  dataDir: string;
  agentId: string;
  taskStore: TaskStore;
  pollIntervalMs?: number;
}

export type RunnerMode = "polling" | "push";

/**
 * Runner daemon: polls for tasks, launches Claude agents, manages lifecycle.
 * Supports dual-mode: push-based via daemon or polling fallback.
 * Integrates with Watchdog for heartbeat-based health monitoring.
 */
export class Runner {
  private options: RunnerOptions;
  private watchdog: Watchdog;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private daemonClient: DaemonClient | null = null;
  private _mode: RunnerMode = "polling";

  constructor(options: RunnerOptions) {
    this.options = options;
    this.watchdog = new Watchdog(
      {
        dataDir: options.dataDir,
        staleThresholdMs: 5 * 60 * 1000,
        scanIntervalMs: 30 * 1000,
      },
      options.taskStore
    );
  }

  get mode(): RunnerMode {
    return this._mode;
  }

  /**
   * Start the runner: try daemon push mode, fall back to polling.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start watchdog for health monitoring
    this.watchdog.start();

    // Try to connect to daemon for push-based mode
    const connected = await this.tryDaemonConnect();
    if (connected) {
      this._mode = "push";
      await this.startPushMode();
    } else {
      this._mode = "polling";
      this.startPollingMode();
    }
  }

  /**
   * Stop the runner and clean up resources.
   */
  async cleanup(): Promise<void> {
    this.running = false;
    this.watchdog.stop();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
    if (this.daemonClient) {
      this.daemonClient.close();
      this.daemonClient = null;
    }
  }

  /**
   * Try to connect to the daemon socket.
   */
  private async tryDaemonConnect(): Promise<boolean> {
    const socketPath = join(this.options.dataDir, "apd.sock");
    const client = new DaemonClient({ socketPath, timeoutMs: 2000 });
    const connected = await client.connect();
    if (connected) {
      this.daemonClient = client;
      return true;
    }
    return false;
  }

  /**
   * Push mode: send runner.ready to daemon, wait for task assignments.
   */
  private async startPushMode(): Promise<void> {
    if (!this.daemonClient || !this.running) return;

    try {
      await this.daemonClient.request("runner.ready", {
        agentId: this.options.agentId,
      });
    } catch {
      // Daemon connection lost, fall back to polling
      this._mode = "polling";
      this.daemonClient?.close();
      this.daemonClient = null;
      this.startPollingMode();
    }
  }

  /**
   * Polling mode: periodically check for available tasks.
   */
  private startPollingMode(): void {
    const pollInterval = this.options.pollIntervalMs ?? 5000;
    this.pollTimer = setInterval(async () => {
      if (!this.running) return;
      try {
        await this.poll();
      } catch (err) {
        console.error(`Runner poll error: ${err}`);
      }
    }, pollInterval);
  }

  /**
   * Single poll iteration: claim a task, write heartbeat, execute, clean up.
   */
  private async poll(): Promise<void> {
    const task = await this.options.taskStore.claim(this.options.agentId);
    if (!task) return;

    await this.executeTask(task);
  }

  /**
   * Execute a claimed task with heartbeat management.
   */
  private async executeTask(task: Task): Promise<void> {
    // Write initial heartbeat on task claim
    await Watchdog.writeHeartbeat(
      this.options.dataDir,
      this.options.agentId,
      task.id,
      "task_claimed"
    );

    try {
      // Task execution would happen here (launch Claude, etc.)
      await this.options.taskStore.update(task.id, { status: "in_progress" });

      // ... actual work happens via the Claude process, which writes
      // heartbeats through the mailbox hook ...

    } catch (err) {
      await this.options.taskStore.update(task.id, {
        status: "failed",
        error: String(err),
      });
    } finally {
      // Clean up heartbeat on task completion
      await Watchdog.clearHeartbeat(
        this.options.dataDir,
        this.options.agentId
      );

      // In push mode, signal ready for next task
      if (this._mode === "push" && this.daemonClient?.connected) {
        try {
          await this.daemonClient.request("runner.ready", {
            agentId: this.options.agentId,
          });
        } catch {
          // Lost daemon connection, switch to polling
          this._mode = "polling";
          this.daemonClient?.close();
          this.daemonClient = null;
          this.startPollingMode();
        }
      }
    }
  }
}
