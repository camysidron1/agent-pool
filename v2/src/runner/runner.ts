// AgentRunner — polls for tasks, delegates to an AgentAdapter

import { createInterface } from 'readline';
import { existsSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AppContext } from '../container.js';
import type { AgentAdapter, AgentContext } from '../adapters/agent.js';
import type { Project, Task, TaskStatus } from '../stores/interfaces.js';
import { DaemonClient } from '../daemon/client.js';

export interface RunnerOptions {
  cloneIndex: number;
  projectName?: string;
  envName?: string;
  skipPermissions: boolean;
  pollInterval?: number; // ms, default 3000
  nonInteractive?: boolean; // skip interactive prompts (for CI/testing)
  daemonSocketPath?: string; // path to daemon socket; auto-detected from dataDir if omitted
}

export class AgentRunner {
  private running = false;
  private agentId: string;
  private projectName: string | null = null;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private softTimeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private daemonClient: DaemonClient | null = null;
  private pushMode = false;

  constructor(
    private ctx: AppContext,
    private adapter: AgentAdapter,
    private options: RunnerOptions,
  ) {
    this.agentId = `agent-${String(options.cloneIndex).padStart(2, '0')}`;
  }

  getAgentId(): string {
    return this.agentId;
  }

  isRunning(): boolean {
    return this.running;
  }

  async start(): Promise<void> {
    this.running = true;
    const project = this.resolveProject();
    this.projectName = project.name;
    const prefix = project.prefix;
    const clonePath = `${this.ctx.config.dataDir}/${prefix}-${String(this.options.cloneIndex).padStart(2, '0')}`;

    this.setupSignalHandlers();

    // Try push mode via daemon first
    const connected = await this.tryConnectDaemon();
    if (connected) {
      console.log(
        `${this.agentId} ready — push mode via daemon (project: ${project.name})`,
      );
      await this.renamePaneQuiet(`${this.agentId}: idle`);
      await this.runPushLoop(project, clonePath);
    }

    // Fall back to polling if push mode wasn't used or daemon disconnected
    if (this.running) {
      console.log(
        `${this.agentId} ready — polling for tasks (project: ${project.name})...`,
      );
      await this.renamePaneQuiet(`${this.agentId}: idle`);
      await this.runPollLoop(project, clonePath);
    }

    this.cleanup();
  }

  private async tryConnectDaemon(): Promise<boolean> {
    const socketPath = this.options.daemonSocketPath
      ?? join(this.ctx.config.dataDir, 'apd.sock');

    const client = new DaemonClient({
      socketPath,
      timeoutMs: 2000,
      onPush: (msg) => this.handlePush(msg),
      onDisconnect: () => {
        console.log(`${this.agentId} daemon disconnected, falling back to polling`);
        this.pushMode = false;
        this.daemonClient = null;
      },
    });

    const ok = await client.connect();
    if (ok) {
      this.daemonClient = client;
      this.pushMode = true;
      return true;
    }
    console.log(`${this.agentId} daemon not available, using polling mode`);
    return false;
  }

  private pushTaskQueue: Task[] = [];
  private pushResolve: (() => void) | null = null;

  private handlePush(msg: import('../daemon/protocol.js').DaemonResponse): void {
    if (msg.result?.type === 'task.assigned' && msg.result.task) {
      this.pushTaskQueue.push(msg.result.task as Task);
      if (this.pushResolve) {
        this.pushResolve();
        this.pushResolve = null;
      }
    } else if (msg.result?.type === 'task.available') {
      // Nudge — re-send runner.ready to request a task
      this.sendRunnerReady().catch(() => {});
    }
  }

  private async sendRunnerReady(): Promise<void> {
    if (!this.daemonClient?.connected) return;
    try {
      await this.daemonClient.request('runner.ready', { agentId: this.agentId });
    } catch {
      // daemon may have disconnected
    }
  }

  private async waitForPushTask(): Promise<Task | null> {
    // Check queue first
    if (this.pushTaskQueue.length > 0) {
      return this.pushTaskQueue.shift()!;
    }
    // Wait for a push or disconnect
    await new Promise<void>((resolve) => {
      this.pushResolve = resolve;
      // Also resolve on periodic check so we can detect disconnect
      const interval = setInterval(() => {
        if (!this.pushMode || !this.running) {
          clearInterval(interval);
          resolve();
        }
      }, 1000);
    });
    return this.pushTaskQueue.shift() ?? null;
  }

  private async runPushLoop(project: Project, clonePath: string): Promise<void> {
    // Signal readiness
    await this.sendRunnerReady();

    while (this.running && this.pushMode) {
      const task = await this.waitForPushTask();

      if (!task) {
        // Disconnected or stopped
        continue;
      }

      await this.executeTask(task, project, clonePath);

      if (this.running && this.pushMode) {
        console.log(`${this.agentId} signaling ready for next task...`);
        await this.renamePaneQuiet(`${this.agentId}: idle`);
        await this.sendRunnerReady();
      }
    }
  }

  private async runPollLoop(project: Project, clonePath: string): Promise<void> {
    while (this.running) {
      const task = this.ctx.stores.tasks.claim(project.name, this.agentId);

      if (!task) {
        await this.sleep(this.options.pollInterval ?? 3000);
        continue;
      }

      await this.executeTask(task, project, clonePath);

      console.log(`${this.agentId} polling for next task...`);
      await this.renamePaneQuiet(`${this.agentId}: idle`);
    }
  }

  private async executeTask(task: Task, project: Project, clonePath: string): Promise<void> {
    console.log(`${this.agentId} claimed task ${task.id}`);
    await this.renamePaneQuiet(this.generatePaneTitle(task));

    const agentCtx = this.buildAgentContext(task, project, clonePath);
    const startedAt = new Date().toISOString();

    await this.adapter.setup(agentCtx);

    // Set up timeout if configured
    this.setupTimeouts(task, agentCtx);

    const exitCode = await this.adapter.run(agentCtx);

    // Clear timeouts
    this.clearTimeouts();

    const completedAt = new Date().toISOString();

    // Write task log
    this.writeTaskLog(agentCtx, startedAt, completedAt, exitCode);

    if (exitCode === 0) {
      this.ctx.stores.tasks.mark(task.id, 'completed');
      console.log(`${this.agentId} completed task ${task.id}`);
    } else {
      await this.handleNonZeroExit(task, exitCode);
    }

    await this.resetClone(clonePath, project.branch);
  }

  stop(): void {
    this.running = false;
    this.pushMode = false;
    if (this.pushResolve) {
      this.pushResolve();
      this.pushResolve = null;
    }
    if (this.daemonClient) {
      this.daemonClient.close();
      this.daemonClient = null;
    }
  }

  buildTrackingContext(project: Project): string | undefined {
    if (!project.trackingType) {
      return `[PROJECT TRACKING — NONE]\nThis project does NOT use issue tracking. Do NOT create, search, or reference Jira tickets or any other tracking system.\n---`;
    }

    const t = project.trackingType.toUpperCase();
    const key = project.trackingProjectKey ?? '';
    const label = project.trackingLabel;
    const instructions = project.trackingInstructions;

    const lines = [`[PROJECT TRACKING — ${t}]`];
    lines.push(
      `This project uses ${t} for issue tracking (project: ${key}${label ? `, label: ${label}` : ''}).`,
    );
    lines.push('- Search for existing tickets before creating new ones');
    lines.push('- Use appropriate CLI commands for ticket operations');
    lines.push(
      `- Prefix commit messages with the ticket key (e.g. ${key}-123: ...)`,
    );
    if (instructions) {
      lines.push(instructions);
    }
    lines.push('---');
    return lines.join('\n');
  }

  buildWorkflowContext(project: Project): string | undefined {
    if (!project.workflowType) {
      return `[GIT WORKFLOW]\nCommit your changes with a descriptive message when your task is complete. Do not create PRs or merge unless specifically asked in the task prompt.\n---`;
    }

    const t = project.workflowType.toUpperCase();
    const instructions = project.workflowInstructions;
    const lines = [`[GIT WORKFLOW — ${t}]`];
    if (instructions) {
      lines.push(instructions);
    }

    // Auto-merge: default true for feature-branch
    let autoMerge = project.workflowAutoMerge;
    if (autoMerge === null && project.workflowType === 'feature-branch') {
      autoMerge = true;
    }
    if (autoMerge) {
      const mergeMethod = project.workflowMergeMethod ?? 'squash';
      lines.push(
        `After creating a PR with \`gh pr create\`, enable auto-merge by running: \`gh pr merge --auto --${mergeMethod}\``,
      );
      lines.push(
        'If auto-merge fails (e.g. not enabled on the repo), log a warning and continue — do not block task completion.',
      );
    }
    lines.push('---');
    return lines.join('\n');
  }

  generatePaneTitle(task: Task): string {
    const firstLine = task.prompt.split('\n')[0].trim();
    const maxLen = 40;
    const truncated =
      firstLine.length > maxLen
        ? firstLine.substring(0, maxLen) + '...'
        : firstLine;
    return `${task.id}: ${truncated}`;
  }

  cleanup(): void {
    this.clearTimeouts();
    if (!this.projectName) return;
    try {
      this.ctx.stores.clones.unlock(this.projectName, this.options.cloneIndex);
    } catch {
      // best-effort unlock, never throws
    }
  }

  private setupSignalHandlers(): void {
    const handler = (signal: string) => {
      console.log(`${this.agentId} received ${signal}, cleaning up...`);
      this.cleanup();
      this.running = false;
      process.exit(signal === 'SIGINT' ? 130 : 143);
    };

    process.on('SIGINT', () => handler('SIGINT'));
    process.on('SIGTERM', () => handler('SIGTERM'));
  }

  private resolveProject(): Project {
    if (this.options.projectName) {
      const project = this.ctx.stores.projects.get(this.options.projectName);
      if (!project) {
        throw new Error(`Project '${this.options.projectName}' not found`);
      }
      return project;
    }
    const defaultProject = this.ctx.stores.projects.getDefault();
    if (!defaultProject) {
      throw new Error('No default project set');
    }
    return defaultProject;
  }

  private async renamePaneQuiet(title: string): Promise<void> {
    try {
      const tabRef = await this.ctx.cmux.identifyTab();
      if (tabRef) {
        await this.ctx.cmux.renameWorkspace(tabRef, title);
      }
    } catch {
      // silently ignore cmux errors
    }
  }

  private async resetClone(
    clonePath: string,
    branch: string,
  ): Promise<void> {
    try {
      await this.ctx.git.fetch(clonePath);
      await this.ctx.git.checkout(clonePath, branch);
      await this.ctx.git.resetHard(clonePath, `origin/${branch}`);
    } catch {
      // best-effort reset, never fails the loop
    }
  }

  private buildAgentContext(
    task: Task,
    project: Project,
    clonePath: string,
  ): AgentContext {
    return {
      taskId: task.id,
      prompt: task.prompt,
      clonePath,
      projectName: project.name,
      agentId: this.agentId,
      branch: project.branch,
      dataDir: this.ctx.config.dataDir,
      toolDir: this.ctx.config.toolDir,
      skipPermissions: this.options.skipPermissions,
      envName: this.options.envName,
      trackingContext: this.buildTrackingContext(project),
      workflowContext: this.buildWorkflowContext(project),
    };
  }

  private setupTimeouts(task: Task, ctx: AgentContext): void {
    if (!task.timeoutMinutes || task.timeoutMinutes <= 0) return;

    const totalMs = task.timeoutMinutes * 60 * 1000;

    // Soft timeout at 80%: write mailbox message
    const softMs = Math.floor(totalMs * 0.8);
    this.softTimeoutTimer = setTimeout(() => {
      const remaining = Math.ceil(task.timeoutMinutes! * 0.2);
      this.writeMailboxMessage(ctx, `⚠️ ${remaining} minutes remaining. Please wrap up your current work and run /finish.`);
      console.log(`${this.agentId} soft timeout: ${remaining}m remaining for ${task.id}`);
    }, softMs);

    // Hard timeout at 100%: kill the process
    this.timeoutTimer = setTimeout(() => {
      console.log(`${this.agentId} TIMEOUT: killing task ${task.id} after ${task.timeoutMinutes}m`);
      if (this.adapter.abort) {
        this.adapter.abort();
      }
      // If still running after 30s, force kill
      setTimeout(() => {
        if (this.adapter.forceKill) {
          this.adapter.forceKill();
        }
      }, 30_000);
    }, totalMs);
  }

  private clearTimeouts(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
    if (this.softTimeoutTimer) {
      clearTimeout(this.softTimeoutTimer);
      this.softTimeoutTimer = null;
    }
  }

  private writeMailboxMessage(ctx: AgentContext, message: string): void {
    try {
      const mailboxDir = join(ctx.dataDir, 'mailbox', ctx.agentId);
      mkdirSync(mailboxDir, { recursive: true });
      const msgFile = join(mailboxDir, `timeout-${Date.now()}.md`);
      writeFileSync(msgFile, message);
    } catch {
      // best-effort
    }
  }

  private writeTaskLog(ctx: AgentContext, startedAt: string, completedAt: string, exitCode: number): void {
    try {
      const logPath = this.adapter.getLogPath?.(ctx) ?? '';
      this.ctx.stores.tasks.addLog({
        taskId: ctx.taskId,
        agentId: ctx.agentId,
        logPath,
        startedAt,
        completedAt,
        exitCode,
      });
    } catch {
      // best-effort log write
    }
  }

  private async handleNonZeroExit(task: Task, exitCode: number): Promise<void> {
    // Check for retry in nonInteractive mode
    if (this.options.nonInteractive) {
      if (this.shouldRetry(task)) {
        this.retryTask(task, exitCode);
        return;
      }
      this.ctx.stores.tasks.mark(task.id, 'blocked', { result: `exit code ${exitCode}` } as Partial<Task>);
      console.log(
        `${this.agentId} blocked on task ${task.id} (exit code: ${exitCode})`,
      );
      return;
    }

    console.log(`${this.agentId} exited with code ${exitCode} on task ${task.id}`);
    console.log('  Mark task as:');
    console.log('  c) completed   b) blocked   p) pending (retry)   k) backlogged');

    const choice = await this.promptChoice('  > ');
    const { status, fields } = this.mapExitChoice(choice);

    this.ctx.stores.tasks.mark(task.id, status, fields);
    console.log(`${this.agentId} marked task ${task.id} as ${status}`);
  }

  private shouldRetry(task: Task): boolean {
    return task.retryMax > 1 && task.retryCount < task.retryMax - 1;
  }

  private retryTask(task: Task, exitCode: number): void {
    const newRetryCount = task.retryCount + 1;
    console.log(
      `${this.agentId} retrying task ${task.id} (attempt ${newRetryCount + 1}/${task.retryMax}, strategy: ${task.retryStrategy})`,
    );

    // Modify prompt based on strategy
    let newPrompt = task.prompt;
    if (task.retryStrategy === 'augmented') {
      newPrompt += `\n\n---\n[RETRY ${newRetryCount + 1}/${task.retryMax}] Previous attempt failed with exit code ${exitCode}. Review what went wrong and try a different approach.`;
    } else if (task.retryStrategy === 'escalate') {
      newPrompt = `[ESCALATED RETRY ${newRetryCount + 1}/${task.retryMax}] This task has failed ${newRetryCount} time(s). Previous exit code: ${exitCode}. Take extra care, review logs, and consider alternative approaches.\n\n${task.prompt}`;
    }
    // 'same' strategy: prompt unchanged

    // Reset task to pending with incremented retry count
    this.ctx.stores.tasks.mark(task.id, 'pending', {
      claimedBy: null,
      startedAt: null,
      completedAt: null,
    });
    this.ctx.stores.tasks.updateFields(task.id, {
      retryCount: newRetryCount,
      prompt: newPrompt,
    });
  }

  private mapExitChoice(choice: string): { status: TaskStatus; fields?: Partial<Task> } {
    switch (choice.toLowerCase()) {
      case 'c':
      case 'completed':
        return { status: 'completed' };
      case 'p':
      case 'pending':
        return {
          status: 'pending',
          fields: { claimedBy: null, startedAt: null, completedAt: null },
        };
      case 'k':
      case 'backlog':
      case 'backlogged':
        return {
          status: 'backlogged',
          fields: { claimedBy: null },
        };
      case 'b':
      case 'blocked':
      default:
        return { status: 'blocked' };
    }
  }

  private promptChoice(question: string): Promise<string> {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    return new Promise(resolve => {
      rl.question(question, answer => {
        rl.close();
        resolve(answer.trim());
      });
    });
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
  }
}
