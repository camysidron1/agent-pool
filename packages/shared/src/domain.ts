export type TaskStatus = "queued" | "running" | "blocked" | "completed" | "failed";

export type ProjectScopedTask = {
  readonly id: string;
  readonly projectId: string;
  readonly title: string;
  readonly status: TaskStatus;
};

export const SHARED_PACKAGE_NAME = "@agent-pool/shared" as const;

export const DEFAULT_PROJECT_TASK_QUEUE = "project-tasks" as const;
