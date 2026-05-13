import type { PublicLogStreamSummary, PublicProjectSummary, PublicSessionSummary, PublicTaskDetail, PublicTaskSummary } from "./api";
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

export type TaskResultSummary = {
  readonly kind: "completed" | "blocked" | "none";
  readonly title: string;
  readonly body: string;
  readonly finalResponseUrls: readonly string[];
  readonly latestLogSummary: string | null;
  readonly commandStates: readonly string[];
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

export function findTask(tasks: readonly PublicTaskSummary[], taskId: string): PublicTaskSummary | null {
  return tasks.find((task) => task.id === taskId) ?? null;
}

export function applyTaskPriority(
  tasks: readonly PublicTaskSummary[],
  input: { readonly taskId: string; readonly priority: number },
): readonly PublicTaskSummary[] {
  return tasks.map((task) => (task.id === input.taskId ? { ...task, priority: input.priority } : task));
}

export type KanbanMoveAction = "unblock" | "backlog";

export function getSupportedMoveAction(task: PublicTaskSummary, targetColumn: BoardColumnId): KanbanMoveAction | null {
  const sourceColumn = getTaskColumnId(task);

  if (sourceColumn === "attention" && targetColumn === "ready" && task.status === "blocked") {
    return "unblock";
  }

  if (sourceColumn === "ready" && targetColumn === "backlog" && task.status === "queued") {
    return "backlog";
  }

  return null;
}

export function applyTaskColumn(
  tasks: readonly PublicTaskSummary[],
  input: { readonly taskId: string; readonly targetColumn: BoardColumnId },
): readonly PublicTaskSummary[] {
  return tasks.map((task) => {
    if (task.id !== input.taskId) return task;

    switch (input.targetColumn) {
      case "ready":
        return { ...task, status: "queued", priority: Math.max(0, task.priority) };
      case "backlog":
        return { ...task, status: "queued", priority: -50 };
      default:
        return task;
    }
  });
}

export function selectActiveSession(task: PublicTaskDetail): PublicSessionSummary | null {
  return (
    task.sessions.find((session) => session.status === "running" || session.status === "starting") ??
    task.latestSession ??
    task.sessions[0] ??
    null
  );
}

export function summarizeLogStream(logStream: PublicLogStreamSummary): string {
  const lineLabel = logStream.lineCount === 1 ? "line" : "lines";
  return `${logStream.kind} · ${logStream.lineCount} ${lineLabel} · offset ${logStream.byteOffset}`;
}

export function getTaskResultSummary(task: PublicTaskDetail): TaskResultSummary {
  const finalResponseUrls = task.artifacts.filter((artifact) => artifact.kind === "final_response_url").map((artifact) => artifact.uri);
  const latestLog = task.logStreams.at(-1) ?? null;
  const latestLogSummary = latestLog ? summarizeLogStream(latestLog) : null;

  if (task.status === "completed") {
    return {
      kind: "completed",
      title: "Completed",
      body: finalResponseUrls.length > 0 ? "Final response artifacts are available." : "Task completed without a final response artifact.",
      finalResponseUrls,
      latestLogSummary,
      commandStates: task.pendingCommands.map(formatCommandState),
    };
  }

  if (task.status === "blocked" || task.status === "failed") {
    return {
      kind: "blocked",
      title: task.status === "failed" ? "Failed" : "Blocked",
      body: readBlockingReason(task) ?? "Task requires operator attention.",
      finalResponseUrls,
      latestLogSummary,
      commandStates: readRecoveryCommandStates(task),
    };
  }

  return {
    kind: "none",
    title: "No result yet",
    body: "Result summary is available when a task completes or needs attention.",
    finalResponseUrls,
    latestLogSummary,
    commandStates: task.pendingCommands.map(formatCommandState),
  };
}

function readBlockingReason(task: PublicTaskDetail): string | null {
  const event = [...task.events]
    .reverse()
    .find((candidate) => candidate.type.includes("failed") || candidate.type.includes("blocked") || candidate.type.includes("lost"));
  if (!event) return null;

  return readPayloadString(event.payload, "reason") ?? readPayloadString(event.payload, "message") ?? readPayloadString(event.payload, "error");
}

function readRecoveryCommandStates(task: PublicTaskDetail): readonly string[] {
  const pending = task.pendingCommands.map(formatCommandState);
  if (pending.length > 0) return pending;

  if (task.status === "blocked") return ["Cancel available", "Retry unavailable"];
  if (task.status === "failed") return ["Retry available", "Cancel unavailable"];

  return [];
}

function formatCommandState(command: { readonly type: string; readonly status: string }): string {
  return `${command.type}: ${command.status}`;
}

function readPayloadString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
  const value = payload[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeProjectId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
