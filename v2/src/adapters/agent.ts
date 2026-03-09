// Agent adapter interfaces

export interface AgentContext {
  taskId: string;
  prompt: string;
  clonePath: string;
  projectName: string;
  agentId: string;
  branch: string;
  dataDir: string;
  toolDir: string;
  skipPermissions: boolean;
  envName?: string;
  trackingContext?: string;
  workflowContext?: string;
}

export interface AgentAdapter {
  /** Prepare the clone for a task (branch, hooks, docs, etc.) */
  setup(ctx: AgentContext): Promise<void>;

  /** Run the agent on the task. Returns exit code. */
  run(ctx: AgentContext): Promise<number>;

  /** Build the full prompt with context prefixes */
  buildPrompt(ctx: AgentContext): string;

  /** Abort the currently running agent process (SIGTERM). */
  abort?(): void;

  /** Force kill the currently running agent process (SIGKILL). */
  forceKill?(): void;

  /** Get the log path for a task run. */
  getLogPath?(ctx: AgentContext): string;
}
