import type { PublicProjectSummary, PublicTaskSummary } from "./api";
import type { BrowserStorage } from "./auth";

export const SELECTED_PROJECT_STORAGE_KEY = "agent-pool.selectedProjectId";

export type BoardColumnId = "attention" | "ready" | "backlog" | "in_progress" | "done";

export type BoardColumn = {
  readonly id: BoardColumnId;
  readonly title: string;
};

export const BOARD_COLUMNS: readonly BoardColumn[] = [
  { id: "attention", title: "Attention" },
  { id: "ready", title: "Ready" },
  { id: "backlog", title: "Backlog" },
  { id: "in_progress", title: "In Progress" },
  { id: "done", title: "Done" },
];

export type PriorityOption = {
  readonly value: number;
  readonly label: string;
};

export const PRIORITY_OPTIONS: readonly PriorityOption[] = [
  { value: 100, label: "Urgent" },
  { value: 50, label: "High" },
  { value: 0, label: "Normal" },
  { value: -10, label: "Low" },
  { value: -50, label: "Backlog" },
];

export function chooseSelectedProjectId(
  projects: readonly PublicProjectSummary[],
  preferredProjectId: string | null,
  storedProjectId: string | null,
): string | null {
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) {
    return preferredProjectId;
  }

  if (storedProjectId && projects.some((project) => project.id === storedProjectId)) {
    return storedProjectId;
  }

  return projects[0]?.id ?? null;
}

export function readStoredSelectedProjectId(storage: BrowserStorage | null): string | null {
  if (!storage) return null;

  try {
    return normalizeProjectId(storage.getItem(SELECTED_PROJECT_STORAGE_KEY));
  } catch {
    return null;
  }
}

export function saveStoredSelectedProjectId(storage: BrowserStorage | null, projectId: string | null): void {
  if (!storage) return;

  try {
    if (projectId) {
      storage.setItem(SELECTED_PROJECT_STORAGE_KEY, projectId);
      return;
    }

    storage.removeItem(SELECTED_PROJECT_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function sortTasksForBoard(tasks: readonly PublicTaskSummary[]): readonly PublicTaskSummary[] {
  return [...tasks].sort((left, right) => {
    if (right.priority !== left.priority) return right.priority - left.priority;
    if (left.displayId !== right.displayId) return left.displayId - right.displayId;

    return left.title.localeCompare(right.title);
  });
}

export function getTaskColumnId(task: PublicTaskSummary): BoardColumnId {
  switch (task.status) {
    case "blocked":
    case "failed":
      return "attention";
    case "running":
      return "in_progress";
    case "completed":
      return "done";
    case "queued":
      return task.priority < 0 ? "backlog" : "ready";
    default:
      return "attention";
  }
}

export function groupTasksByColumn(tasks: readonly PublicTaskSummary[]): Record<BoardColumnId, readonly PublicTaskSummary[]> {
  const grouped: Record<BoardColumnId, PublicTaskSummary[]> = {
    attention: [],
    ready: [],
    backlog: [],
    in_progress: [],
    done: [],
  };

  for (const task of sortTasksForBoard(tasks)) {
    grouped[getTaskColumnId(task)].push(task);
  }

  return grouped;
}

export function getPriorityLabel(priority: number): string {
  const exact = PRIORITY_OPTIONS.find((option) => option.value === priority);
  if (exact) return exact.label;
  if (priority > 100) return "Urgent";
  if (priority > 0) return "High";
  if (priority === 0) return "Normal";

  return "Backlog";
}

export function replaceTask(tasks: readonly PublicTaskSummary[], updatedTask: PublicTaskSummary): readonly PublicTaskSummary[] {
  return tasks.map((task) => (task.id === updatedTask.id ? updatedTask : task));
}

export function applyTaskPriority(
  tasks: readonly PublicTaskSummary[],
  input: { readonly taskId: string; readonly priority: number },
): readonly PublicTaskSummary[] {
  return tasks.map((task) => (task.id === input.taskId ? { ...task, priority: input.priority } : task));
}

function normalizeProjectId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
