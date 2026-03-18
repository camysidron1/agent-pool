// Store interfaces and domain types

export type TaskStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'backlogged' | 'cancelled';

export type RetryStrategy = 'same' | 'augmented' | 'escalate';

export interface Project {
  name: string;
  source: string;
  prefix: string;
  branch: string;
  setup: string | null;
  isDefault: boolean;
  trackingType: string | null;
  trackingProjectKey: string | null;
  trackingLabel: string | null;
  trackingInstructions: string | null;
  workflowType: string | null;
  workflowInstructions: string | null;
  workflowAutoMerge: boolean | null;
  workflowMergeMethod: string | null;
  agentType: string | null;
}

export interface ProjectInput {
  name: string;
  source: string;
  prefix?: string;
  branch?: string;
  setup?: string | null;
}

export interface Clone {
  id: number;
  projectName: string;
  cloneIndex: number;
  locked: boolean;
  workspaceId: string;
  lockedAt: string | null;
  branch: string;
}

export interface Task {
  id: string;
  projectName: string;
  prompt: string;
  status: TaskStatus;
  claimedBy: string | null;
  createdAt: string;
  startedAt: string | null;
  completedAt: string | null;
  priority: number;
  timeoutMinutes: number | null;
  retryMax: number;
  retryCount: number;
  retryStrategy: RetryStrategy;
  result: string | null;
  pipelineId: string | null;
  pipelineStepId: string | null;
}

export interface TaskInput {
  projectName: string;
  prompt: string;
  status?: TaskStatus;
  dependsOn?: string[];
  priority?: number;
  timeoutMinutes?: number;
  retryMax?: number;
  retryStrategy?: RetryStrategy;
  pipelineId?: string;
  pipelineStepId?: string;
}

export type PipelineStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled';

export interface Pipeline {
  id: string;
  projectName: string;
  name: string;
  params: Record<string, string> | null;
  status: PipelineStatus;
  createdAt: string;
  completedAt: string | null;
}

export interface TaskLog {
  id?: number;
  taskId: string;
  agentId: string;
  logPath: string;
  startedAt: string;
  completedAt: string | null;
  exitCode: number | null;
  createdAt: string;
}

// --- Store interfaces ---

export interface ProjectStore {
  getAll(): Project[];
  get(name: string): Project | null;
  getDefault(): Project | null;
  add(project: ProjectInput): void;
  remove(name: string): void;
  setDefault(name: string): void;
  update(name: string, fields: Partial<Project>): void;
}

export interface CloneStore {
  getAll(projectName: string): Clone[];
  get(projectName: string, index: number): Clone | null;
  add(projectName: string, index: number, branch: string): void;
  remove(projectName: string, index: number): void;
  lock(projectName: string, index: number, workspaceId: string): void;
  unlock(projectName: string, index: number): void;
  findFree(projectName: string): Clone | null;
  nextIndex(projectName: string): number;
}

export interface PipelineStore {
  get(id: string): Pipeline | null;
  getAll(projectName: string): Pipeline[];
  create(pipeline: Omit<Pipeline, 'completedAt'>): Pipeline;
  updateStatus(id: string, status: PipelineStatus): void;
  refreshStatus(id: string): PipelineStatus;
  getByProject(projectName: string): Pipeline[];
}

export interface TaskStore {
  getAll(projectName: string): Task[];
  get(id: string): Task | null;
  add(task: TaskInput): Task;
  /** Read-only peek: return the next claimable task without mutating state. Same selection rules as claim. */
  peek(projectName: string): Task | null;
  /** Atomic claim: find first eligible pending task, mark in_progress. Priority DESC, then created_at ASC. */
  claim(projectName: string, agentId: string): Task | null;
  mark(id: string, status: TaskStatus, fields?: Partial<Task>): void;
  /** Update non-status fields on a task. */
  updateFields(id: string, fields: Partial<Pick<Task, 'priority' | 'timeoutMinutes' | 'retryMax' | 'retryStrategy' | 'result' | 'prompt' | 'retryCount'>>): void;
  getDependencies(taskId: string): string[];
  addDependency(taskId: string, dependsOn: string): void;
  addLog(log: Omit<TaskLog, 'id' | 'createdAt'>): TaskLog;
  getLogs(filter: { taskId?: string; agentId?: string; limit?: number }): TaskLog[];
  /** Reset all in_progress tasks claimed by a given agent back to pending. Returns count released. */
  releaseAgent(projectName: string, agentId: string): number;
  getByPipeline(pipelineId: string): Task[];
}
