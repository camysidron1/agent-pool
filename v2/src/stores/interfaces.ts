/**
 * Task status values used throughout the system.
 */
export type TaskStatus =
  | "pending"
  | "active"
  | "in_progress"
  | "completed"
  | "failed"
  | "blocked"
  | "backlog";

/**
 * A task in the queue.
 */
export interface Task {
  id: string;
  description: string;
  status: TaskStatus;
  agent_id?: string;
  depends_on?: string[];
  created_at: string;
  updated_at: string;
  error?: string;
  retry_count?: number;
  timeout_at?: string;
}

/**
 * Interface for task persistence.
 */
export interface TaskStore {
  list(): Promise<Task[]>;
  get(id: string): Promise<Task | undefined>;
  update(id: string, fields: Partial<Task>): Promise<void>;
  add(task: Omit<Task, "id" | "created_at" | "updated_at">): Promise<Task>;
  claim(agentId: string): Promise<Task | undefined>;
}
