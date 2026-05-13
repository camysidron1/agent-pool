import { describe, expect, test } from "bun:test";

import {
  applyTaskPriority,
  chooseSelectedProjectId,
  getPriorityLabel,
  getTaskColumnId,
  groupTasksByColumn,
  readStoredSelectedProjectId,
  replaceTask,
  saveStoredSelectedProjectId,
  SELECTED_PROJECT_STORAGE_KEY,
  sortTasksForBoard,
} from "../src/board";
import type { PublicProjectSummary, PublicTaskSummary } from "../src/api";
import type { BrowserStorage } from "../src/auth";

describe("web board state", () => {
  test("chooses preferred stored or first project without leaking across projects", () => {
    const projects = [project("project-a"), project("project-b")];

    expect(chooseSelectedProjectId(projects, "project-b", "project-a")).toBe("project-b");
    expect(chooseSelectedProjectId(projects, "missing", "project-a")).toBe("project-a");
    expect(chooseSelectedProjectId(projects, "missing", "also-missing")).toBe("project-a");
    expect(chooseSelectedProjectId([], "project-a", "project-a")).toBeNull();
  });

  test("persists selected project defensively", () => {
    const storage = new MemoryStorage();

    saveStoredSelectedProjectId(storage, "project-a");
    expect(storage.getItem(SELECTED_PROJECT_STORAGE_KEY)).toBe("project-a");
    expect(readStoredSelectedProjectId(storage)).toBe("project-a");

    saveStoredSelectedProjectId(storage, null);
    expect(readStoredSelectedProjectId(storage)).toBeNull();
  });

  test("sorts loaded tasks by priority then display id", () => {
    expect(
      sortTasksForBoard([
        task("task-low", 2, 1, "B task"),
        task("task-high-late", 8, 4, "C task"),
        task("task-high-early", 8, 1, "A task"),
      ]).map((item) => item.id),
    ).toEqual(["task-high-early", "task-high-late", "task-low"]);
  });

  test("groups canonical backend statuses into web Kanban columns", () => {
    const grouped = groupTasksByColumn([
      task("attention-blocked", 0, 1, "Blocked task", "blocked"),
      task("attention-failed", 0, 2, "Failed task", "failed"),
      task("ready", 0, 3, "Ready task", "queued"),
      task("backlog", -50, 4, "Backlog task", "queued"),
      task("in-progress", 0, 5, "Running task", "running"),
      task("done", 0, 6, "Done task", "completed"),
    ]);

    expect(grouped.attention.map((item) => item.id)).toEqual(["attention-blocked", "attention-failed"]);
    expect(grouped.ready.map((item) => item.id)).toEqual(["ready"]);
    expect(grouped.backlog.map((item) => item.id)).toEqual(["backlog"]);
    expect(grouped.in_progress.map((item) => item.id)).toEqual(["in-progress"]);
    expect(grouped.done.map((item) => item.id)).toEqual(["done"]);
  });

  test("updates priority labels and task lists immutably", () => {
    const original = [task("task-a", 0, 1, "A task"), task("task-b", 50, 2, "B task")];
    const prioritized = applyTaskPriority(original, { taskId: "task-a", priority: -50 });
    const replaced = replaceTask(prioritized, task("task-b", 100, 2, "B task"));

    expect(original[0]?.priority).toBe(0);
    expect(prioritized[0]?.priority).toBe(-50);
    expect(getTaskColumnId(prioritized[0] as PublicTaskSummary)).toBe("backlog");
    expect(getPriorityLabel(100)).toBe("Urgent");
    expect(getPriorityLabel(-50)).toBe("Backlog");
    expect(replaced[1]?.priority).toBe(100);
  });
});

function project(id: string): PublicProjectSummary {
  return {
    id,
    slug: id,
    name: id,
    description: null,
    status: "active",
    taskCounts: { queued: 0, running: 0, blocked: 0, completed: 0, failed: 0 },
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
  };
}

function task(
  id: string,
  priority: number,
  displayId: number,
  title: string,
  status: PublicTaskSummary["status"] = "queued",
): PublicTaskSummary {
  return {
    id,
    projectId: "project-a",
    displayId,
    title,
    description: null,
    status,
    priority,
    runtimeSource: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    latestSession: null,
    pendingCommands: [],
  };
}

class MemoryStorage implements BrowserStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
