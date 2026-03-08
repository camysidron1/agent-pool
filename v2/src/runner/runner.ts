import { Watchdog } from "./watchdog";
import type { TaskStore } from "../stores/interfaces";

export interface RunnerOptions {
  dataDir: string;
  agentId: string;
  taskStore: TaskStore;
  pollIntervalMs?: number;
}

/**
 * Runner daemon: polls for tasks, launches Claude agents, manages lifecycle.
 * Integrates with Watchdog for heartbeat-based health monitoring.
 */
export class Runner {
  private options: RunnerOptions;
  private watchdog: Watchdog;
  private running = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;

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

  /**
   * Start the runner: begins watchdog monitoring and task polling.
   */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Start watchdog for health monitoring
    this.watchdog.start();

    // Start polling for tasks
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
   * Stop the runner and clean up resources.
   */
  async cleanup(): Promise<void> {
    this.running = false;
    this.watchdog.stop();
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Single poll iteration: claim a task, write heartbeat, execute, clean up.
   */
  private async poll(): Promise<void> {
    const task = await this.options.taskStore.claim(this.options.agentId);
    if (!task) return;

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
    }
  }
}
