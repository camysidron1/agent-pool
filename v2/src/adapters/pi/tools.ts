// Native tools for Pi-based agents — task management via direct TaskStore access

import { Type, type Static } from '@sinclair/typebox';
import type { ToolDefinition, ExtensionContext } from '@mariozechner/pi-coding-agent';
import type { AgentToolResult, AgentToolUpdateCallback } from '@mariozechner/pi-agent-core';
import type { TaskStore, TaskStatus, TaskInput } from '../../stores/interfaces.js';

export interface ToolContext {
  taskStore: TaskStore;
  projectName: string;
  agentId: string;
  taskId: string;
  policy: TaskCreationPolicy;
}

export interface TaskCreationPolicy {
  maxTasksPerExecution: number;
}

const DEFAULT_POLICY: TaskCreationPolicy = { maxTasksPerExecution: 10 };

function textResult(text: string): AgentToolResult<{}> {
  return { content: [{ type: 'text', text }], details: {} };
}

// --- create_task ---

const CreateTaskParams = Type.Object({
  prompt: Type.String({ description: 'Task description / prompt for the agent that will pick this up' }),
  priority: Type.Optional(Type.Number({ description: 'Priority (higher = claimed first). Default: 0' })),
});

function createTaskTool(ctx: ToolContext): ToolDefinition {
  let tasksCreated = 0;
  const limit = ctx.policy.maxTasksPerExecution;

  return {
    name: 'create_task',
    label: 'Create Task',
    description: 'Create a new task for another agent to pick up. The task is added to the shared queue and will be claimed by the next available agent.',
    promptSnippet: 'create_task — add a task to the queue for another agent',
    parameters: CreateTaskParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof CreateTaskParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{}>> {
      if (tasksCreated >= limit) {
        return textResult(`Rate limit reached: max ${limit} tasks per execution. Task not created.`);
      }

      const input: TaskInput = {
        projectName: ctx.projectName,
        prompt: params.prompt,
        priority: params.priority ?? 0,
      };

      const task = ctx.taskStore.add(input);
      tasksCreated++;

      return textResult(`Task created: ${task.id} (${tasksCreated}/${limit} task creation budget used)`);
    },
  };
}

// --- list_tasks ---

const ListTasksParams = Type.Object({
  status: Type.Optional(Type.String({ description: 'Filter by status: pending, in_progress, completed, blocked, backlogged, cancelled' })),
});

function listTasksTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'list_tasks',
    label: 'List Tasks',
    description: 'List tasks in the project queue, optionally filtered by status.',
    promptSnippet: 'list_tasks — view the task queue',
    parameters: ListTasksParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof ListTasksParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{}>> {
      let tasks = ctx.taskStore.getAll(ctx.projectName);
      if (params.status) {
        tasks = tasks.filter(t => t.status === params.status);
      }

      if (tasks.length === 0) {
        return textResult(params.status ? `No ${params.status} tasks.` : 'No tasks in queue.');
      }

      const lines = tasks.map(t =>
        `${t.id} [${t.status}] priority=${t.priority} — ${t.prompt.slice(0, 120)}${t.prompt.length > 120 ? '…' : ''}`
      );
      return textResult(lines.join('\n'));
    },
  };
}

// --- get_task_status ---

const GetTaskStatusParams = Type.Object({
  taskId: Type.String({ description: 'The task ID to look up' }),
});

function getTaskStatusTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'get_task_status',
    label: 'Get Task Status',
    description: 'Get the current status and details of a specific task.',
    promptSnippet: 'get_task_status — check a task by ID',
    parameters: GetTaskStatusParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof GetTaskStatusParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      _ctx: ExtensionContext,
    ): Promise<AgentToolResult<{}>> {
      const task = ctx.taskStore.get(params.taskId);
      if (!task) {
        return textResult(`Task ${params.taskId} not found.`);
      }

      const lines = [
        `ID: ${task.id}`,
        `Status: ${task.status}`,
        `Priority: ${task.priority}`,
        `Created: ${task.createdAt}`,
        task.claimedBy ? `Claimed by: ${task.claimedBy}` : null,
        task.startedAt ? `Started: ${task.startedAt}` : null,
        task.completedAt ? `Completed: ${task.completedAt}` : null,
        task.result ? `Result: ${task.result}` : null,
        `Prompt: ${task.prompt}`,
      ].filter(Boolean);

      return textResult(lines.join('\n'));
    },
  };
}

// --- finish_task ---

const VALID_FINISH_STATUSES = new Set<string>(['completed', 'blocked', 'pending', 'backlogged']);

const FinishTaskParams = Type.Object({
  status: Type.String({ description: 'Final status: completed, blocked, pending (retry), or backlogged' }),
  result: Type.Optional(Type.String({ description: 'Optional result message or notes' })),
});

function finishTaskTool(ctx: ToolContext): ToolDefinition {
  return {
    name: 'finish_task',
    label: 'Finish Task',
    description: 'Mark the current task with a final status and end the session. Use "completed" when done, "blocked" if stuck, "pending" to retry, or "backlogged" to deprioritize.',
    promptSnippet: 'finish_task — mark current task done/blocked and exit',
    promptGuidelines: [
      'Always call finish_task when you are done with the current task. Do not just stop — explicitly finish.',
    ],
    parameters: FinishTaskParams,
    async execute(
      _toolCallId: string,
      params: Static<typeof FinishTaskParams>,
      _signal: AbortSignal | undefined,
      _onUpdate: AgentToolUpdateCallback | undefined,
      extCtx: ExtensionContext,
    ): Promise<AgentToolResult<{}>> {
      if (!VALID_FINISH_STATUSES.has(params.status)) {
        return textResult(`Invalid status "${params.status}". Use: ${[...VALID_FINISH_STATUSES].join(', ')}`);
      }

      const fields = params.result ? { result: params.result } : undefined;
      ctx.taskStore.mark(ctx.taskId, params.status as TaskStatus, fields);

      // Signal shutdown so the session ends after this tool call
      extCtx.abort();

      return textResult(`Task ${ctx.taskId} marked as ${params.status}. Session ending.`);
    },
  };
}

// --- Factory ---

export function createPiTools(toolCtx: Partial<ToolContext> & Pick<ToolContext, 'taskStore' | 'projectName' | 'agentId' | 'taskId'>): ToolDefinition[] {
  const ctx: ToolContext = {
    ...toolCtx,
    policy: toolCtx.policy ?? DEFAULT_POLICY,
  };

  return [
    createTaskTool(ctx),
    listTasksTool(ctx),
    getTaskStatusTool(ctx),
    finishTaskTool(ctx),
  ];
}
