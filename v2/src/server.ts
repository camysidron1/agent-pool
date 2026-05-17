import { appendFile, mkdir } from 'fs/promises';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

import { createProductionContext, type AppContext } from './container.js';
import { DaemonClient } from './daemon/client.js';
import type { PoolEvent } from './daemon/event-bus.js';
import { ProjectService } from './services/project-service.js';
import { TaskService, type QueueSummary } from './services/task-service.js';
import type {
  Clone,
  Project,
  RetryStrategy,
  Task,
  TaskInput,
  TaskLog,
} from './stores/interfaces.js';
import { notifyDaemon } from './util/notify-daemon.js';

export type {
  Clone,
  Project,
  RetryStrategy,
  Task,
  TaskInput,
  TaskLog,
  TaskStatus,
} from './stores/interfaces.js';

export type AgentStatus = 'working' | 'idle' | 'offline' | 'stale';

export type AgentHeartbeatSummary = {
  timestamp: string;
  pid: number;
  taskId: string;
  lastTool: string;
  ageMs: number | null;
};

export type TaskSummary = Task & {
  dependsOn: string[];
};

export type AgentSummary = {
  agentId: string;
  cloneIndex: number | null;
  status: AgentStatus;
  clone: Clone | null;
  task: TaskSummary | null;
  heartbeat: AgentHeartbeatSummary | null;
};

export type DaemonSummary = {
  socketPath: string;
  pidPath: string;
  running: boolean;
  status: {
    pid: number;
    uptimeMs: number;
    connectedClients: number;
    readyRunners: number;
  } | null;
  error: string | null;
};

export type AgentPoolSnapshot = {
  generatedAt: string;
  project: Project;
  projects: Project[];
  queue: QueueSummary;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  daemon: DaemonSummary;
};

export type TaskDetail = {
  task: TaskSummary;
  dependencies: TaskSummary[];
  logs: TaskLog[];
  activeAgent: AgentSummary | null;
};

export type TaskLogReadResult = {
  log: TaskLog | null;
  path: string | null;
  exists: boolean;
  truncated: boolean;
  text: string;
};

export type TaskReviewArtifact = {
  kind: 'file' | 'diff' | 'link' | 'log' | 'other';
  title: string;
  path?: string;
  url?: string;
  text?: string;
  metadata?: Record<string, unknown>;
};

export type TaskReview = {
  taskId: string;
  projectName: string;
  agentId: string | null;
  clonePath: string | null;
  summaryMarkdown: string;
  changedFiles: string[];
  diffSummary: string;
  artifacts: TaskReviewArtifact[];
  links: string[];
  presentation: string[];
  source: 'manifest' | 'fallback';
  manifestPath: string | null;
};

export type SendTaskFeedbackInput = TaskIdInput & {
  message: string;
};

export type TaskFeedbackResult = {
  task: TaskDetail;
  agentId: string;
  clonePath: string;
  mailboxPath: string;
  deliveredAt: string;
};

export type SubmitTaskReviewInput = TaskIdInput & {
  decision: 'accept' | 'request_changes';
  feedback?: string;
};

export type TaskReviewSubmissionResult = {
  task: TaskDetail;
  review: TaskReview;
  decision: SubmitTaskReviewInput['decision'];
  feedback: string | null;
};

export type AgentPoolEvent =
  | { type: 'snapshot'; snapshot: AgentPoolSnapshot }
  | { type: 'pool-event'; event: PoolEvent; snapshot: AgentPoolSnapshot | null }
  | { type: 'error'; message: string };

export type AgentPoolServerOptions = {
  dataDir?: string;
  toolDir?: string;
  projectName?: string;
  staleHeartbeatMs?: number;
  ssePollIntervalMs?: number;
  daemonStatusTimeoutMs?: number;
};

export type SnapshotInput = {
  projectName?: string;
};

export type CreateTaskInput = {
  projectName?: string;
  prompt: string;
  priority?: number;
  dependsOn?: string[];
  timeoutMinutes?: number;
  retryMax?: number;
  retryStrategy?: RetryStrategy;
  branch?: string;
  backlog?: boolean;
};

export type UpdateTaskInput = {
  taskId: string;
  prompt?: string;
  priority?: number;
  timeoutMinutes?: number | null;
  retryMax?: number;
  retryStrategy?: RetryStrategy;
  result?: string | null;
};

export type TaskIdInput = {
  taskId: string;
};

export type ReadTaskLogInput = TaskIdInput & {
  tailLines?: number;
};

export type CreateSseResponseInput = SnapshotInput & {
  pollIntervalMs?: number;
};

export type AgentPoolServer = {
  getSnapshot(input?: SnapshotInput): Promise<AgentPoolSnapshot>;
  createTask(input: CreateTaskInput): Promise<TaskDetail>;
  updateTask(input: UpdateTaskInput): Promise<TaskDetail>;
  cancelTask(input: TaskIdInput): Promise<TaskDetail>;
  backlogTask(input: TaskIdInput): Promise<TaskDetail>;
  activateTask(input: TaskIdInput): Promise<TaskDetail>;
  unblockTask(input: TaskIdInput): Promise<TaskDetail>;
  getTaskDetail(input: TaskIdInput): Promise<TaskDetail>;
  readTaskLog(input: ReadTaskLogInput): Promise<TaskLogReadResult>;
  sendTaskFeedback(input: SendTaskFeedbackInput): Promise<TaskFeedbackResult>;
  submitTaskReview(input: SubmitTaskReviewInput): Promise<TaskReviewSubmissionResult>;
  getTaskReview(input: TaskIdInput): Promise<TaskReview>;
  createSseResponse(input?: CreateSseResponseInput): Response;
  close(): void;
};

type HeartbeatRecord = {
  timestamp: string;
  pid: number;
  task_id: string;
  last_tool: string;
};

type EventLogCursor = {
  offset: number;
  remainder: string;
};

const DEFAULT_STALE_HEARTBEAT_MS = 5 * 60 * 1000;
const DEFAULT_SSE_POLL_INTERVAL_MS = 1000;
const DEFAULT_DAEMON_STATUS_TIMEOUT_MS = 1000;

export function createAgentPoolServer(options: AgentPoolServerOptions = {}): AgentPoolServer {
  const dataDir = options.dataDir ?? defaultDataDir();
  const toolDir = options.toolDir ?? defaultToolDir();
  const ctx = createProductionContext({ dataDir, toolDir });
  return new AgentPoolServerImpl(ctx, {
    ...options,
    dataDir,
    toolDir,
  });
}

class AgentPoolServerImpl implements AgentPoolServer {
  private readonly projectService: ProjectService;
  private readonly taskService: TaskService;
  private readonly dataDir: string;
  private readonly toolDir: string;
  private readonly defaultProjectName?: string;
  private readonly staleHeartbeatMs: number;
  private readonly ssePollIntervalMs: number;
  private readonly daemonStatusTimeoutMs: number;
  private closed = false;

  constructor(
    private readonly ctx: AppContext,
    options: Required<Pick<AgentPoolServerOptions, 'dataDir' | 'toolDir'>> & AgentPoolServerOptions,
  ) {
    this.projectService = new ProjectService(ctx.stores.projects);
    this.taskService = new TaskService(ctx.stores.tasks);
    this.dataDir = options.dataDir;
    this.toolDir = options.toolDir;
    this.defaultProjectName = options.projectName;
    this.staleHeartbeatMs = options.staleHeartbeatMs ?? DEFAULT_STALE_HEARTBEAT_MS;
    this.ssePollIntervalMs = options.ssePollIntervalMs ?? DEFAULT_SSE_POLL_INTERVAL_MS;
    this.daemonStatusTimeoutMs = options.daemonStatusTimeoutMs ?? DEFAULT_DAEMON_STATUS_TIMEOUT_MS;
  }

  async getSnapshot(input: SnapshotInput = {}): Promise<AgentPoolSnapshot> {
    this.assertOpen();
    const project = this.resolveProject(input.projectName);
    const tasks = this.taskService.list(project.name).map((task) => this.toTaskSummary(task));
    const agents = this.buildAgentSummaries(project, tasks);

    return {
      generatedAt: new Date().toISOString(),
      project,
      projects: this.projectService.list(),
      queue: this.taskService.getQueueSummary(project.name),
      tasks,
      agents,
      daemon: await this.readDaemonSummary(),
    };
  }

  async createTask(input: CreateTaskInput): Promise<TaskDetail> {
    this.assertOpen();
    const project = this.resolveProject(input.projectName);
    const prompt = input.prompt.trim();
    if (!prompt) throw new Error('Task prompt is required');
    this.assertRetryStrategy(input.retryStrategy);

    const task = this.taskService.add({
      projectName: project.name,
      prompt,
      status: input.backlog ? 'backlogged' : 'pending',
      dependsOn: input.dependsOn,
      priority: input.priority,
      timeoutMinutes: input.timeoutMinutes,
      retryMax: input.retryMax,
      retryStrategy: input.retryStrategy,
      branch: input.branch,
    });

    await this.persistEvent({
      type: 'task.created',
      timestamp: new Date().toISOString(),
      payload: { taskId: task.id, projectName: project.name },
    });
    this.notifyDaemonIfRunning();

    return this.getTaskDetail({ taskId: task.id });
  }

  async updateTask(input: UpdateTaskInput): Promise<TaskDetail> {
    this.assertOpen();
    const task = this.requireTask(input.taskId);
    this.assertRetryStrategy(input.retryStrategy);

    const fields: Parameters<TaskService['updateFields']>[1] = {};
    if (input.prompt !== undefined) {
      const prompt = input.prompt.trim();
      if (!prompt) throw new Error('Task prompt is required');
      fields.prompt = prompt;
    }
    if (input.priority !== undefined) fields.priority = input.priority;
    if (input.timeoutMinutes !== undefined) fields.timeoutMinutes = input.timeoutMinutes;
    if (input.retryMax !== undefined) fields.retryMax = input.retryMax;
    if (input.retryStrategy !== undefined) fields.retryStrategy = input.retryStrategy;
    if (input.result !== undefined) fields.result = input.result;

    if (Object.keys(fields).length > 0) {
      this.taskService.updateFields(task.id, fields);
    }

    return this.getTaskDetail({ taskId: task.id });
  }

  async cancelTask(input: TaskIdInput): Promise<TaskDetail> {
    this.assertOpen();
    const task = this.requireTask(input.taskId);
    this.taskService.setStatus(task.id, 'cancelled');
    await this.persistEvent({
      type: 'task.cancelled',
      timestamp: new Date().toISOString(),
      payload: { taskId: task.id, projectName: task.projectName },
    });
    return this.getTaskDetail({ taskId: task.id });
  }

  async backlogTask(input: TaskIdInput): Promise<TaskDetail> {
    this.assertOpen();
    this.taskService.backlog(input.taskId);
    return this.getTaskDetail(input);
  }

  async activateTask(input: TaskIdInput): Promise<TaskDetail> {
    this.assertOpen();
    this.taskService.activate(input.taskId);
    return this.getTaskDetail(input);
  }

  async unblockTask(input: TaskIdInput): Promise<TaskDetail> {
    this.assertOpen();
    this.taskService.unblock(input.taskId);
    return this.getTaskDetail(input);
  }

  async getTaskDetail(input: TaskIdInput): Promise<TaskDetail> {
    this.assertOpen();
    const task = this.requireTask(input.taskId);
    const summary = this.toTaskSummary(task);
    const dependencies = summary.dependsOn
      .map((dependencyId) => this.ctx.stores.tasks.get(dependencyId))
      .filter((dependency): dependency is Task => Boolean(dependency))
      .map((dependency) => this.toTaskSummary(dependency));
    const logs = this.taskService.getLogs({ taskId: task.id });
    const project = this.projectService.resolve(task.projectName);
    const agents = this.buildAgentSummaries(project, this.taskService.list(project.name).map((candidate) => this.toTaskSummary(candidate)));

    return {
      task: summary,
      dependencies,
      logs,
      activeAgent: task.claimedBy ? agents.find((agent) => agent.agentId === task.claimedBy) ?? null : null,
    };
  }

  async readTaskLog(input: ReadTaskLogInput): Promise<TaskLogReadResult> {
    this.assertOpen();
    this.requireTask(input.taskId);
    const [log] = this.taskService.getLogs({ taskId: input.taskId, limit: 1 });
    if (!log) {
      return { log: null, path: null, exists: false, truncated: false, text: '' };
    }

    if (!log.logPath || !existsSync(log.logPath)) {
      return { log, path: log.logPath || null, exists: false, truncated: false, text: '' };
    }

    const raw = readFileSync(log.logPath, 'utf-8');
    if (!input.tailLines || input.tailLines <= 0) {
      return { log, path: log.logPath, exists: true, truncated: false, text: raw };
    }

    const lines = raw.split('\n');
    const truncated = lines.length > input.tailLines;
    return {
      log,
      path: log.logPath,
      exists: true,
      truncated,
      text: lines.slice(-input.tailLines).join('\n'),
    };
  }

  async sendTaskFeedback(input: SendTaskFeedbackInput): Promise<TaskFeedbackResult> {
    this.assertOpen();
    const message = input.message.trim();
    if (!message) throw new Error('Feedback message is required');

    const task = this.requireTask(input.taskId);
    if (task.status !== 'in_progress' || !task.claimedBy) {
      throw new Error(`Task '${task.id}' is not actively claimed`);
    }

    const target = this.requireTaskClone(task);
    if (!existsSync(target.clonePath)) {
      throw new Error(`Clone path '${target.clonePath}' does not exist`);
    }

    const mailboxPath = join(target.clonePath, '.mailbox');
    writeFileSync(mailboxPath, message);
    const deliveredAt = new Date().toISOString();

    await this.persistEvent({
      type: 'task.feedback_delivered',
      timestamp: deliveredAt,
      payload: {
        taskId: task.id,
        projectName: task.projectName,
        agentId: target.agentId,
      },
    });

    return {
      task: await this.getTaskDetail({ taskId: task.id }),
      agentId: target.agentId,
      clonePath: target.clonePath,
      mailboxPath,
      deliveredAt,
    };
  }

  async submitTaskReview(input: SubmitTaskReviewInput): Promise<TaskReviewSubmissionResult> {
    this.assertOpen();
    const task = this.requireTask(input.taskId);
    if (task.status !== 'review_requested') {
      throw new Error(`Task '${task.id}' is not awaiting review (status: ${task.status})`);
    }
    const review = await this.getTaskReview({ taskId: task.id });

    if (input.decision === 'accept') {
      this.taskService.setStatus(task.id, 'completed');
      await this.persistEvent({
        type: 'task.review_accepted',
        timestamp: new Date().toISOString(),
        payload: { taskId: task.id, projectName: task.projectName },
      });
      await this.persistEvent({
        type: 'task.completed',
        timestamp: new Date().toISOString(),
        payload: { taskId: task.id, projectName: task.projectName, status: 'completed' },
      });
    } else {
      const feedback = input.feedback?.trim();
      if (!feedback) throw new Error('Review feedback is required when requesting changes');
      const nextPrompt = `${task.prompt}\n\n---\n[REVIEW FEEDBACK ${new Date().toISOString()}]\n${feedback}`;
      this.taskService.updateFields(task.id, {
        prompt: nextPrompt,
        result: `Review requested changes: ${feedback}`,
      });
      this.taskService.setStatus(task.id, 'pending');
      await this.persistEvent({
        type: 'task.review_changes_requested',
        timestamp: new Date().toISOString(),
        payload: { taskId: task.id, projectName: task.projectName },
      });
      this.notifyDaemonIfRunning();
    }

    return {
      task: await this.getTaskDetail({ taskId: task.id }),
      review,
      decision: input.decision,
      feedback: input.feedback?.trim() || null,
    };
  }

  async getTaskReview(input: TaskIdInput): Promise<TaskReview> {
    this.assertOpen();
    const task = this.requireTask(input.taskId);
    const target = this.findTaskClone(task);
    const manifestPath = target ? join(target.clonePath, 'agent-docs', 'reviews', `${task.id}.json`) : null;

    if (manifestPath && existsSync(manifestPath)) {
      const manifest = readJsonObject(manifestPath);
      if (manifest) {
        return this.reviewFromManifest(task, target?.agentId ?? task.claimedBy, target?.clonePath ?? null, manifestPath, manifest);
      }
    }

    return this.fallbackReview(task, target?.agentId ?? task.claimedBy, target?.clonePath ?? null, manifestPath);
  }

  createSseResponse(input: CreateSseResponseInput = {}): Response {
    this.assertOpen();
    const encoder = new TextEncoder();
    const pollIntervalMs = input.pollIntervalMs ?? this.ssePollIntervalMs;
    let interval: ReturnType<typeof setInterval> | null = null;
    let closed = false;
    let cursor: EventLogCursor = {
      offset: this.currentEventLogSize(),
      remainder: '',
    };
    let lastSnapshotSignature = '';

    const stream = new ReadableStream<Uint8Array>({
      start: async (controller) => {
        const send = (name: string, event: AgentPoolEvent): void => {
          if (closed) return;
          controller.enqueue(encoder.encode(formatSseMessage(name, event)));
        };

        const sendSnapshot = async (): Promise<AgentPoolSnapshot | null> => {
          try {
            const snapshot = await this.getSnapshot(input);
            lastSnapshotSignature = snapshotSignature(snapshot);
            send('snapshot', { type: 'snapshot', snapshot });
            return snapshot;
          } catch (error) {
            send('error', { type: 'error', message: errorMessage(error) });
            return null;
          }
        };

        await sendSnapshot();

        interval = setInterval(() => {
          void (async () => {
            for (const event of this.readNewPersistedEvents(cursor)) {
              const snapshot = await this.getSnapshot(input).catch(() => null);
              if (snapshot) lastSnapshotSignature = snapshotSignature(snapshot);
              send('pool-event', { type: 'pool-event', event, snapshot });
            }

            const snapshot = await this.getSnapshot(input).catch((error) => {
              send('error', { type: 'error', message: errorMessage(error) });
              return null;
            });
            if (!snapshot) return;

            const signature = snapshotSignature(snapshot);
            if (signature !== lastSnapshotSignature) {
              lastSnapshotSignature = signature;
              send('snapshot', { type: 'snapshot', snapshot });
            }
          })();
        }, pollIntervalMs);
      },
      cancel: () => {
        closed = true;
        if (interval) clearInterval(interval);
      },
    });

    return new Response(stream, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
      },
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.ctx.db.close();
  }

  private requireTaskClone(task: Task): { project: Project; agentId: string; clone: Clone; clonePath: string } {
    const target = this.findTaskClone(task);
    if (!target) throw new Error(`Task '${task.id}' has no active clone`);
    return target;
  }

  private findTaskClone(task: Task): { project: Project; agentId: string; clone: Clone; clonePath: string } | null {
    if (!task.claimedBy) return null;
    const cloneIndex = parseCloneIndex(task.claimedBy);
    if (cloneIndex === null) return null;
    const project = this.projectService.resolve(task.projectName);
    const clone = this.ctx.stores.clones.get(project.name, cloneIndex);
    if (!clone) return null;
    return {
      project,
      agentId: task.claimedBy,
      clone,
      clonePath: this.clonePath(project, clone.cloneIndex),
    };
  }

  private clonePath(project: Project, cloneIndex: number): string {
    return join(this.dataDir, `${project.prefix}-${String(cloneIndex).padStart(2, '0')}`);
  }

  private reviewFromManifest(
    task: Task,
    agentId: string | null,
    clonePath: string | null,
    manifestPath: string,
    manifest: Record<string, unknown>,
  ): TaskReview {
    const summaryMarkdown = readString(manifest.summaryMarkdown)
      || readString(manifest.summary)
      || task.result
      || `Task ${task.id} is ready for review.`;
    const changedFiles = readStringArray(manifest.changedFiles);
    const diffSummary = readString(manifest.diffSummary) || '';
    const artifacts = readArtifacts(manifest.artifacts);
    const links = [...new Set([...readStringArray(manifest.links), ...extractLinks(summaryMarkdown)])];
    const presentation = readStringArray(manifest.presentation);

    return {
      taskId: task.id,
      projectName: task.projectName,
      agentId,
      clonePath,
      summaryMarkdown,
      changedFiles,
      diffSummary,
      artifacts,
      links,
      presentation: presentation.length > 0 ? presentation : defaultPresentation(summaryMarkdown, diffSummary),
      source: 'manifest',
      manifestPath,
    };
  }

  private async fallbackReview(
    task: Task,
    agentId: string | null,
    clonePath: string | null,
    manifestPath: string | null,
  ): Promise<TaskReview> {
    const logRead = await this.readTaskLog({ taskId: task.id, tailLines: 80 });
    const gitStatus = clonePath ? gitOutput(clonePath, ['status', '--short']) : '';
    const diffSummary = clonePath ? gitOutput(clonePath, ['diff', '--stat']) : '';
    const changedFiles = uniqueStrings([
      ...parseGitStatusFiles(gitStatus),
      ...(clonePath ? gitOutput(clonePath, ['diff', '--name-only']).split('\n').map((line) => line.trim()).filter(Boolean) : []),
    ]);
    const summaryMarkdown = task.result
      || (logRead.text ? `Latest task log excerpt:\n\n\`\`\`\n${trimForReview(logRead.text)}\n\`\`\`` : `Task ${task.id} is ready for review.`);
    const artifacts: TaskReviewArtifact[] = [];
    if (logRead.path) {
      artifacts.push({ kind: 'log', title: 'Task log', path: logRead.path });
    }
    if (diffSummary) {
      artifacts.push({ kind: 'diff', title: 'Diff summary', text: diffSummary });
    }
    for (const file of changedFiles) {
      artifacts.push({ kind: 'file', title: file, path: clonePath ? join(clonePath, file) : file });
    }

    return {
      taskId: task.id,
      projectName: task.projectName,
      agentId,
      clonePath,
      summaryMarkdown,
      changedFiles,
      diffSummary,
      artifacts,
      links: extractLinks(`${summaryMarkdown}\n${logRead.text}`),
      presentation: defaultPresentation(summaryMarkdown, diffSummary),
      source: 'fallback',
      manifestPath,
    };
  }

  private resolveProject(projectName?: string): Project {
    return this.projectService.resolve(projectName ?? this.defaultProjectName);
  }

  private requireTask(taskId: string): Task {
    const task = this.taskService.get(taskId);
    if (!task) throw new Error(`Task '${taskId}' not found`);
    return task;
  }

  private toTaskSummary(task: Task): TaskSummary {
    return {
      ...task,
      dependsOn: this.taskService.getDependencies(task.id),
    };
  }

  private buildAgentSummaries(project: Project, tasks: TaskSummary[]): AgentSummary[] {
    const heartbeats = this.readHeartbeats();
    const inProgressByAgent = new Map<string, TaskSummary>();
    for (const task of tasks) {
      if (task.status === 'in_progress' && task.claimedBy) {
        inProgressByAgent.set(task.claimedBy, task);
      }
    }

    const summaries: AgentSummary[] = [];
    const seenAgents = new Set<string>();

    for (const clone of this.ctx.stores.clones.getAll(project.name)) {
      const agentId = agentIdForCloneIndex(clone.cloneIndex);
      seenAgents.add(agentId);
      summaries.push(this.buildAgentSummary({
        agentId,
        cloneIndex: clone.cloneIndex,
        clone,
        task: inProgressByAgent.get(agentId) ?? null,
        heartbeat: heartbeats.get(agentId) ?? null,
      }));
    }

    for (const [agentId, heartbeat] of heartbeats) {
      if (seenAgents.has(agentId)) continue;
      summaries.push(this.buildAgentSummary({
        agentId,
        cloneIndex: parseCloneIndex(agentId),
        clone: null,
        task: inProgressByAgent.get(agentId) ?? null,
        heartbeat,
      }));
    }

    return summaries.sort((left, right) => {
      const leftIndex = left.cloneIndex ?? Number.MAX_SAFE_INTEGER;
      const rightIndex = right.cloneIndex ?? Number.MAX_SAFE_INTEGER;
      if (leftIndex !== rightIndex) return leftIndex - rightIndex;
      return left.agentId.localeCompare(right.agentId);
    });
  }

  private buildAgentSummary(input: {
    agentId: string;
    cloneIndex: number | null;
    clone: Clone | null;
    task: TaskSummary | null;
    heartbeat: HeartbeatRecord | null;
  }): AgentSummary {
    const heartbeat = input.heartbeat ? this.toHeartbeatSummary(input.heartbeat) : null;
    const status = heartbeat && heartbeat.ageMs !== null && heartbeat.ageMs > this.staleHeartbeatMs
      ? 'stale'
      : input.clone?.locked && input.task
        ? 'working'
        : input.clone?.locked
          ? 'idle'
          : 'offline';

    return {
      agentId: input.agentId,
      cloneIndex: input.cloneIndex,
      status,
      clone: input.clone,
      task: input.task,
      heartbeat,
    };
  }

  private toHeartbeatSummary(heartbeat: HeartbeatRecord): AgentHeartbeatSummary {
    const timestampMs = Date.parse(heartbeat.timestamp);
    const ageMs = Number.isFinite(timestampMs) ? Math.max(0, Date.now() - timestampMs) : null;
    return {
      timestamp: heartbeat.timestamp,
      pid: heartbeat.pid,
      taskId: heartbeat.task_id,
      lastTool: heartbeat.last_tool,
      ageMs,
    };
  }

  private readHeartbeats(): Map<string, HeartbeatRecord> {
    const heartbeats = new Map<string, HeartbeatRecord>();
    const heartbeatDir = join(this.dataDir, 'heartbeats');
    let files: string[];
    try {
      files = readdirSync(heartbeatDir).filter((file) => file.endsWith('.json'));
    } catch {
      return heartbeats;
    }

    for (const file of files) {
      try {
        const data = JSON.parse(readFileSync(join(heartbeatDir, file), 'utf-8')) as HeartbeatRecord;
        if (typeof data.timestamp !== 'string' || typeof data.pid !== 'number' || typeof data.task_id !== 'string') {
          continue;
        }
        heartbeats.set(file.replace(/\.json$/, ''), {
          timestamp: data.timestamp,
          pid: data.pid,
          task_id: data.task_id,
          last_tool: typeof data.last_tool === 'string' ? data.last_tool : '',
        });
      } catch {
        // Ignore corrupted heartbeat files.
      }
    }

    return heartbeats;
  }

  private async readDaemonSummary(): Promise<DaemonSummary> {
    const socketPath = join(this.dataDir, 'apd.sock');
    const pidPath = join(this.dataDir, 'apd.pid');
    if (!existsSync(socketPath)) {
      return { socketPath, pidPath, running: false, status: null, error: null };
    }

    const client = new DaemonClient({ socketPath, timeoutMs: this.daemonStatusTimeoutMs });
    const connected = await client.connect();
    if (!connected) {
      return { socketPath, pidPath, running: false, status: null, error: null };
    }

    try {
      const response = await client.request('status');
      const status = response.result as {
        pid?: unknown;
        uptime?: unknown;
        connectedClients?: unknown;
        readyRunners?: unknown;
      } | undefined;
      return {
        socketPath,
        pidPath,
        running: true,
        status: {
          pid: readNumber(status?.pid),
          uptimeMs: readNumber(status?.uptime),
          connectedClients: readNumber(status?.connectedClients),
          readyRunners: readNumber(status?.readyRunners),
        },
        error: response.error ?? null,
      };
    } catch (error) {
      return { socketPath, pidPath, running: true, status: null, error: errorMessage(error) };
    } finally {
      client.close();
    }
  }

  private async persistEvent(event: PoolEvent): Promise<void> {
    const file = this.eventLogPath();
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(event)}\n`);
  }

  private notifyDaemonIfRunning(): void {
    if (existsSync(join(this.dataDir, 'apd.sock'))) {
      notifyDaemon(this.dataDir);
    }
  }

  private eventLogPath(): string {
    return join(this.dataDir, 'events.jsonl');
  }

  private currentEventLogSize(): number {
    try {
      return statSync(this.eventLogPath()).size;
    } catch {
      return 0;
    }
  }

  private readNewPersistedEvents(cursor: EventLogCursor): PoolEvent[] {
    const file = this.eventLogPath();
    if (!existsSync(file)) return [];

    let text: string;
    try {
      text = readFileSync(file, 'utf-8');
    } catch {
      return [];
    }

    if (text.length < cursor.offset) {
      cursor.offset = 0;
      cursor.remainder = '';
    }

    const chunk = text.slice(cursor.offset);
    cursor.offset = text.length;
    if (!chunk) return [];

    const lines = `${cursor.remainder}${chunk}`.split('\n');
    cursor.remainder = lines.pop() ?? '';
    const events: PoolEvent[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line) as PoolEvent);
      } catch {
        // Ignore malformed persisted event lines.
      }
    }

    return events;
  }

  private assertRetryStrategy(strategy: RetryStrategy | undefined): void {
    if (!strategy) return;
    if (!['same', 'augmented', 'escalate'].includes(strategy)) {
      throw new Error(`Invalid retry strategy '${strategy}'`);
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('Agent Pool server is closed');
  }
}

function defaultDataDir(): string {
  const env = process.env as Record<string, string | undefined>;
  if (env.AGENT_POOL_DATA_DIR?.trim()) return env.AGENT_POOL_DATA_DIR.trim();
  if (env.HOME?.trim()) return join(env.HOME.trim(), '.agent-pool', 'data');
  return join(process.cwd(), '.agent-pool', 'data');
}

function defaultToolDir(): string {
  const env = process.env as Record<string, string | undefined>;
  if (env.AGENT_POOL_TOOL_DIR?.trim()) return env.AGENT_POOL_TOOL_DIR.trim();
  if (env.HOME?.trim()) return join(env.HOME.trim(), '.agent-pool');
  return process.cwd();
}

function agentIdForCloneIndex(index: number): string {
  return `agent-${String(index).padStart(2, '0')}`;
}

function parseCloneIndex(agentId: string): number | null {
  const match = /^agent-(\d+)$/.exec(agentId);
  return match ? Number(match[1]) : null;
}

function readNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatSseMessage(name: string, event: AgentPoolEvent): string {
  return `event: ${name}\ndata: ${JSON.stringify(event)}\n\n`;
}

function snapshotSignature(snapshot: AgentPoolSnapshot): string {
  return JSON.stringify({
    projectName: snapshot.project.name,
    queue: {
      total: snapshot.queue.total,
      pending: snapshot.queue.pending,
      inProgress: snapshot.queue.inProgress,
      blocked: snapshot.queue.blocked,
      reviewRequested: snapshot.queue.reviewRequested,
      waitingOnDeps: snapshot.queue.waitingOnDeps,
      claimable: snapshot.queue.claimable,
      completed: snapshot.queue.completed,
      backlogged: snapshot.queue.backlogged,
      cancelled: snapshot.queue.cancelled,
      nextClaimableId: snapshot.queue.nextClaimable?.id ?? null,
    },
    tasks: snapshot.tasks.map((task) => ({
      id: task.id,
      status: task.status,
      claimedBy: task.claimedBy,
      priority: task.priority,
      retryCount: task.retryCount,
      completedAt: task.completedAt,
      startedAt: task.startedAt,
    })),
    agents: snapshot.agents.map((agent) => ({
      agentId: agent.agentId,
      status: agent.status,
      taskId: agent.task?.id ?? null,
      locked: agent.clone?.locked ?? null,
      heartbeatAt: agent.heartbeat?.timestamp ?? null,
      heartbeatTool: agent.heartbeat?.lastTool ?? null,
    })),
    daemon: {
      running: snapshot.daemon.running,
      connectedClients: snapshot.daemon.status?.connectedClients ?? null,
      readyRunners: snapshot.daemon.status?.readyRunners ?? null,
    },
  });
}

function readJsonObject(path: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function readString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

function readArtifacts(value: unknown): TaskReviewArtifact[] {
  if (!Array.isArray(value)) return [];
  const artifacts: TaskReviewArtifact[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const record = item as Record<string, unknown>;
    const title = readString(record.title) || readString(record.path) || readString(record.url);
    if (!title) continue;
    const kind = ['file', 'diff', 'link', 'log', 'other'].includes(readString(record.kind))
      ? readString(record.kind) as TaskReviewArtifact['kind']
      : 'other';
    artifacts.push({
      kind,
      title,
      path: readString(record.path) || undefined,
      url: readString(record.url) || undefined,
      text: readString(record.text) || undefined,
      metadata: record.metadata && typeof record.metadata === 'object' && !Array.isArray(record.metadata)
        ? record.metadata as Record<string, unknown>
        : undefined,
    });
  }
  return artifacts;
}

function gitOutput(cwd: string, args: string[]): string {
  if (!existsSync(cwd)) return '';
  try {
    const result = Bun.spawnSync(['git', ...args], { cwd, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) return '';
    return new TextDecoder().decode(result.stdout).trim();
  } catch {
    return '';
  }
}

function parseGitStatusFiles(status: string): string[] {
  return status
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter(Boolean)
    .map((file) => file.includes(' -> ') ? file.split(' -> ').pop()!.trim() : file);
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function extractLinks(text: string): string[] {
  return uniqueStrings(text.match(/https?:\/\/[^\s)]+/g) ?? []);
}

function trimForReview(text: string): string {
  return text.length > 4000 ? `${text.slice(-4000)}` : text;
}

function defaultPresentation(summaryMarkdown: string, diffSummary: string): string[] {
  return diffSummary ? [summaryMarkdown, diffSummary] : [summaryMarkdown];
}
