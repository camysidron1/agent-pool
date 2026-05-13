import type { PublicProjectSummary, PublicTaskSummary } from "./api";
import type { BrowserStorage } from "./auth";

export const SELECTED_PROJECT_STORAGE_KEY = "agent-pool.selectedProjectId";

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

function normalizeProjectId(value: string | null): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}
