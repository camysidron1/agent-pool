import type {
  AgentPoolServer,
  AgentPoolSnapshot,
  AgentSummary,
  SubmitTaskReviewInput,
  TaskReview,
  TaskSummary,
} from './server.js';

export type AgentPoolAgUiMode = 'dispatch' | 'observe' | 'feedback' | 'review';

export type AgentPoolAgUiForwardedProps = {
  agentPool?: {
    mode?: AgentPoolAgUiMode;
    projectName?: string;
    taskId?: string;
    message?: string;
    decision?: SubmitTaskReviewInput['decision'];
    feedback?: string;
    priority?: number;
    dependsOn?: string[];
    timeoutMinutes?: number;
    retryMax?: number;
    retryStrategy?: 'same' | 'augmented' | 'escalate';
    branch?: string;
  };
};

export type AgentValleyLocation = 'computer' | 'whiteboard' | 'kitchen' | 'game_room' | 'offscreen' | 'needs_attention';

export type AgentValleyAgent = {
  agentId: string;
  status: AgentSummary['status'];
  location: AgentValleyLocation;
  activity: string;
  currentTaskId: string | null;
  lastTool: string | null;
  heartbeatAgeMs: number | null;
};

export type AgentValleyTask = {
  taskId: string;
  promptPreview: string;
  status: TaskSummary['status'];
  agentId: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  dependsOn: string[];
};

export type AgentValleyReview = {
  taskId: string;
  agentId: string | null;
  summaryMarkdown: string;
  artifacts: TaskReview['artifacts'];
  changedFiles: string[];
  diffSummary: string;
};

export type AgentValleyState = {
  version: 1;
  project: AgentPoolSnapshot['project'];
  queue: AgentPoolSnapshot['queue'];
  daemon: AgentPoolSnapshot['daemon'];
  agents: AgentValleyAgent[];
  tasks: AgentValleyTask[];
  reviews: AgentValleyReview[];
};

export type AgentPoolAgUiHandlerOptions = {
  pollIntervalMs?: number;
};

type AgUiRunAgentInput = {
  threadId?: string;
  runId?: string;
  parentRunId?: string;
  state?: unknown;
  messages?: AgUiMessage[];
  forwardedProps?: AgentPoolAgUiForwardedProps & Record<string, unknown>;
  tools?: unknown[];
  context?: unknown[];
};

type AgUiMessage = {
  id?: string;
  role?: string;
  content?: unknown;
};

type AgUiEvent = Record<string, unknown> & {
  type: string;
  timestamp?: number;
};

const DEFAULT_POLL_INTERVAL_MS = 500;
const ACTIVITY_MESSAGE_ID = 'agent-pool-office';

export function createAgentPoolAgUiHandler(
  pool: AgentPoolServer,
  options: AgentPoolAgUiHandlerOptions = {},
): (request: Request) => Promise<Response> {
  return async (request: Request): Promise<Response> => {
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405 });
    }

    let input: AgUiRunAgentInput;
    try {
      input = await request.json() as AgUiRunAgentInput;
    } catch {
      return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
    }

    return createAgUiStream(pool, input, options);
  };
}

export function getAgentPoolAgUiCapabilities(): Record<string, unknown> {
  return {
    protocol: 'ag-ui',
    transport: { stream: true, sse: true },
    state: { snapshots: true, deltas: false, shared: true },
    agents: { multiAgent: true, observe: true, dispatch: true },
    humanInTheLoop: { reviewRequired: true, feedback: true, interrupts: true },
  };
}

async function createAgentValleyState(
  pool: AgentPoolServer,
  projectName?: string,
): Promise<AgentValleyState> {
  const snapshot = await pool.getSnapshot({ projectName });
  const reviewTasks = snapshot.tasks.filter((task) => task.status === 'review_requested');
  const reviews = await Promise.all(reviewTasks.map(async (task): Promise<AgentValleyReview> => {
    const review = await pool.getTaskReview({ taskId: task.id });
    return {
      taskId: review.taskId,
      agentId: review.agentId,
      summaryMarkdown: review.summaryMarkdown,
      artifacts: review.artifacts,
      changedFiles: review.changedFiles,
      diffSummary: review.diffSummary,
    };
  }));

  return {
    version: 1,
    project: snapshot.project,
    queue: snapshot.queue,
    daemon: snapshot.daemon,
    agents: snapshot.agents.map(toAgentValleyAgent),
    tasks: snapshot.tasks.map(toAgentValleyTask),
    reviews,
  };
}

function createAgUiStream(
  pool: AgentPoolServer,
  input: AgUiRunAgentInput,
  options: AgentPoolAgUiHandlerOptions,
): Response {
  const encoder = new TextEncoder();
  const threadId = input.threadId || crypto.randomUUID();
  const runId = input.runId || crypto.randomUUID();
  const forwarded = input.forwardedProps?.agentPool ?? {};
  const mode = forwarded.mode ?? 'dispatch';
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  let closed = false;
  let interval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: AgUiEvent): void => {
        if (closed) return;
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(withTimestamp(event))}\n\n`));
      };
      const close = (): void => {
        if (closed) return;
        closed = true;
        if (interval) clearInterval(interval);
        controller.close();
      };

      send(runStarted(threadId, runId, input));

      const handleError = (error: unknown): void => {
        send({
          type: 'RUN_ERROR',
          message: error instanceof Error ? error.message : String(error),
        });
        close();
      };

      if (mode === 'observe') {
        void startObserve(pool, forwarded.projectName, send, pollIntervalMs, () => closed, (timer) => {
          interval = timer;
        }).catch(handleError);
        return;
      }

      const run = mode === 'dispatch'
        ? runDispatch(pool, input, threadId, runId, send, pollIntervalMs, () => closed, close)
        : mode === 'feedback'
          ? runFeedback(pool, input, threadId, runId, send, close)
          : mode === 'review'
            ? runReview(pool, input, threadId, runId, send, close)
            : Promise.reject(new Error(`Unsupported AG-UI mode '${mode}'`));

      void run.catch(handleError);
    },
    cancel() {
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

async function runDispatch(
  pool: AgentPoolServer,
  input: AgUiRunAgentInput,
  threadId: string,
  runId: string,
  send: (event: AgUiEvent) => void,
  pollIntervalMs: number,
  isClosed: () => boolean,
  close: () => void,
): Promise<void> {
  const forwarded = input.forwardedProps?.agentPool ?? {};
  const prompt = latestUserText(input);
  if (!prompt) throw new Error('Dispatch mode requires a user message');

  const created = await pool.createTask({
    projectName: forwarded.projectName,
    prompt: buildAgentValleyPrompt(prompt),
    priority: forwarded.priority,
    dependsOn: forwarded.dependsOn,
    timeoutMinutes: forwarded.timeoutMinutes,
    retryMax: forwarded.retryMax,
    retryStrategy: forwarded.retryStrategy,
    branch: forwarded.branch,
  });
  await narrate(send, `Queued task ${created.task.id} for the agent pool.`);
  await emitState(pool, forwarded.projectName, send);
  send(custom('agent_pool.task_created', { taskId: created.task.id, projectName: created.task.projectName }));

  let lastStatus = created.task.status;
  let lastSignature = '';

  while (!isClosed()) {
    const state = await createAgentValleyState(pool, forwarded.projectName);
    const task = state.tasks.find((candidate) => candidate.taskId === created.task.id);
    const signature = stableStateSignature(state);
    if (signature !== lastSignature) {
      lastSignature = signature;
      send({ type: 'STATE_SNAPSHOT', snapshot: state });
      send(activitySnapshot(state));
    }

    if (task && task.status !== lastStatus) {
      lastStatus = task.status;
      send(custom(customEventNameForStatus(task.status), { taskId: task.taskId, status: task.status, agentId: task.agentId }));
    }

    if (task && isDispatchTerminal(task.status)) {
      if (task.status === 'review_requested') {
        const review = await pool.getTaskReview({ taskId: task.taskId });
        const reviewState = await createAgentValleyState(pool, forwarded.projectName);
        send({ type: 'STATE_SNAPSHOT', snapshot: reviewState });
        send({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          result: {
            outcome: { type: 'interrupt', reason: 'agent_pool:review_required' },
            taskId: task.taskId,
            review,
          },
        });
      } else {
        send({
          type: 'RUN_FINISHED',
          threadId,
          runId,
          result: { outcome: { type: 'terminal', status: task.status }, taskId: task.taskId },
        });
      }
      close();
      return;
    }

    await sleep(pollIntervalMs);
  }
}

async function startObserve(
  pool: AgentPoolServer,
  projectName: string | undefined,
  send: (event: AgUiEvent) => void,
  pollIntervalMs: number,
  isClosed: () => boolean,
  setIntervalRef: (timer: ReturnType<typeof setInterval>) => void,
): Promise<void> {
  let lastSignature = '';
  const tick = async (): Promise<void> => {
    if (isClosed()) return;
    const state = await createAgentValleyState(pool, projectName);
    const signature = stableStateSignature(state);
    if (signature === lastSignature) return;
    lastSignature = signature;
    send({ type: 'STATE_SNAPSHOT', snapshot: state });
    send(activitySnapshot(state));
  };

  await tick();
  setIntervalRef(setInterval(() => {
    void tick().catch((error) => {
      send({
        type: 'RUN_ERROR',
        message: error instanceof Error ? error.message : String(error),
      });
    });
  }, pollIntervalMs));
}

async function runFeedback(
  pool: AgentPoolServer,
  input: AgUiRunAgentInput,
  threadId: string,
  runId: string,
  send: (event: AgUiEvent) => void,
  close: () => void,
): Promise<void> {
  const forwarded = input.forwardedProps?.agentPool ?? {};
  const taskId = forwarded.taskId;
  if (!taskId) throw new Error('Feedback mode requires forwardedProps.agentPool.taskId');
  const message = forwarded.message || latestUserText(input);
  const result = await pool.sendTaskFeedback({ taskId, message });
  send(custom('agent_pool.feedback_delivered', {
    taskId,
    agentId: result.agentId,
    deliveredAt: result.deliveredAt,
  }));
  await emitState(pool, forwarded.projectName, send);
  send({ type: 'RUN_FINISHED', threadId, runId, result: { outcome: { type: 'feedback_delivered' }, taskId } });
  close();
}

async function runReview(
  pool: AgentPoolServer,
  input: AgUiRunAgentInput,
  threadId: string,
  runId: string,
  send: (event: AgUiEvent) => void,
  close: () => void,
): Promise<void> {
  const forwarded = input.forwardedProps?.agentPool ?? {};
  const taskId = forwarded.taskId;
  if (!taskId) throw new Error('Review mode requires forwardedProps.agentPool.taskId');
  const decision = forwarded.decision;
  if (decision !== 'accept' && decision !== 'request_changes') {
    throw new Error('Review mode requires decision accept or request_changes');
  }

  const result = await pool.submitTaskReview({
    taskId,
    decision,
    feedback: forwarded.feedback || latestUserText(input),
  });
  send(custom(decision === 'accept' ? 'agent_pool.review_accepted' : 'agent_pool.review_changes_requested', {
    taskId,
    decision,
  }));
  await emitState(pool, forwarded.projectName, send);
  send({ type: 'RUN_FINISHED', threadId, runId, result: { outcome: { type: 'review_submitted', decision }, taskId, task: result.task.task } });
  close();
}

async function emitState(
  pool: AgentPoolServer,
  projectName: string | undefined,
  send: (event: AgUiEvent) => void,
): Promise<void> {
  const state = await createAgentValleyState(pool, projectName);
  send({ type: 'STATE_SNAPSHOT', snapshot: state });
  send(activitySnapshot(state));
}

async function narrate(send: (event: AgUiEvent) => void, text: string): Promise<void> {
  const messageId = crypto.randomUUID();
  send({ type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' });
  send({ type: 'TEXT_MESSAGE_CONTENT', messageId, delta: text });
  send({ type: 'TEXT_MESSAGE_END', messageId });
}

function runStarted(threadId: string, runId: string, input: AgUiRunAgentInput): AgUiEvent {
  return {
    type: 'RUN_STARTED',
    threadId,
    runId,
    parentRunId: input.parentRunId,
    input,
  };
}

function custom(name: string, value: Record<string, unknown>): AgUiEvent {
  return { type: 'CUSTOM', name, value };
}

function activitySnapshot(state: AgentValleyState): AgUiEvent {
  return {
    type: 'ACTIVITY_SNAPSHOT',
    messageId: ACTIVITY_MESSAGE_ID,
    activityType: 'agent_pool_office',
    content: {
      agents: state.agents,
      tasks: state.tasks,
      reviews: state.reviews,
    },
    replace: true,
  };
}

function toAgentValleyAgent(agent: AgentSummary): AgentValleyAgent {
  return {
    agentId: agent.agentId,
    status: agent.status,
    location: locationForAgent(agent),
    activity: activityForAgent(agent),
    currentTaskId: agent.task?.id ?? null,
    lastTool: agent.heartbeat?.lastTool ?? null,
    heartbeatAgeMs: agent.heartbeat?.ageMs ?? null,
  };
}

function toAgentValleyTask(task: TaskSummary): AgentValleyTask {
  return {
    taskId: task.id,
    promptPreview: task.prompt.length > 140 ? `${task.prompt.slice(0, 137)}...` : task.prompt,
    status: task.status,
    agentId: task.claimedBy,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    completedAt: task.completedAt,
    dependsOn: task.dependsOn,
  };
}

function locationForAgent(agent: AgentSummary): AgentValleyLocation {
  if (agent.status === 'stale') return 'needs_attention';
  if (agent.status === 'offline') return 'offscreen';
  if (agent.status === 'idle') return (agent.cloneIndex ?? 0) % 2 === 0 ? 'kitchen' : 'game_room';
  return isCodingTool(agent.heartbeat?.lastTool) ? 'computer' : 'whiteboard';
}

function activityForAgent(agent: AgentSummary): string {
  if (agent.status === 'working') return agent.heartbeat?.lastTool ? `Using ${agent.heartbeat.lastTool}` : 'Working';
  if (agent.status === 'idle') return 'Waiting for work';
  if (agent.status === 'stale') return 'Needs attention';
  return 'Offline';
}

function isCodingTool(tool: string | undefined): boolean {
  if (!tool) return false;
  return /bash|edit|write|patch|terminal|shell/i.test(tool);
}

function latestUserText(input: AgUiRunAgentInput): string {
  const messages = input.messages ?? [];
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (message.role === 'user') return messageContentToText(message.content).trim();
  }
  return '';
}

function messageContentToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => {
      if (typeof part === 'string') return part;
      if (part && typeof part === 'object' && 'text' in part && typeof (part as { text?: unknown }).text === 'string') {
        return (part as { text: string }).text;
      }
      return '';
    })
    .join('');
}

function buildAgentValleyPrompt(prompt: string): string {
  return `${prompt}

---
[AGENT VALLEY REVIEW CONTRACT]
When the work is ready for human review:
1. Write a review manifest to agent-docs/reviews/$AGENT_POOL_TASK_ID.json.
2. Use this manifest shape:
   {
     "taskId": "$AGENT_POOL_TASK_ID",
     "summaryMarkdown": "What changed and why",
     "changedFiles": ["path/to/file"],
     "diffSummary": "Short diff summary",
     "artifacts": [],
     "links": [],
     "presentation": []
   }
3. Finish with /finish review_requested, or run:
   bun run "$AGENT_POOL_TOOL_DIR/v2/src/finish-task.ts" review_requested
`;
}

function customEventNameForStatus(status: TaskSummary['status']): string {
  switch (status) {
    case 'in_progress': return 'agent_pool.task_claimed';
    case 'review_requested': return 'agent_pool.task_review_requested';
    case 'completed': return 'agent_pool.task_completed';
    case 'blocked': return 'agent_pool.task_blocked';
    case 'cancelled': return 'agent_pool.task_cancelled';
    default: return `agent_pool.task_${status}`;
  }
}

function isDispatchTerminal(status: TaskSummary['status']): boolean {
  return status === 'review_requested' || status === 'blocked' || status === 'cancelled' || status === 'completed';
}

function stableStateSignature(state: AgentValleyState): string {
  return JSON.stringify({
    queue: state.queue,
    agents: state.agents,
    tasks: state.tasks,
    reviews: state.reviews.map((review) => ({
      taskId: review.taskId,
      agentId: review.agentId,
      changedFiles: review.changedFiles,
      diffSummary: review.diffSummary,
      summaryMarkdown: review.summaryMarkdown,
    })),
    daemon: {
      running: state.daemon.running,
      connectedClients: state.daemon.status?.connectedClients ?? null,
      readyRunners: state.daemon.status?.readyRunners ?? null,
    },
  });
}

function withTimestamp(event: AgUiEvent): AgUiEvent {
  return event.timestamp === undefined ? { ...event, timestamp: Date.now() } : event;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
