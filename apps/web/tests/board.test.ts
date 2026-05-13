import { describe, expect, test } from "bun:test";

import {
  applyTaskColumn,
  applyTaskPriority,
  chooseSelectedProjectId,
  getPriorityLabel,
  getTaskResultSummary,
  getSupportedMoveAction,
  getTaskColumnId,
  groupTasksByColumn,
  readStoredSelectedProjectId,
  replaceTask,
  saveStoredSelectedProjectId,
  SELECTED_PROJECT_STORAGE_KEY,
  selectActiveSession,
  sortTasksForBoard,
  summarizeLogStream,
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

  test("allows only supported optimistic Kanban moves", () => {
    const blocked = task("blocked", 0, 1, "Blocked task", "blocked");
    const queued = task("queued", 0, 2, "Queued task", "queued");
    const failed = task("failed", 0, 3, "Failed task", "failed");

    expect(getSupportedMoveAction(blocked, "ready")).toBe("unblock");
    expect(getSupportedMoveAction(queued, "backlog")).toBe("backlog");
    expect(getSupportedMoveAction(failed, "ready")).toBeNull();
    expect(getSupportedMoveAction(queued, "in_progress")).toBeNull();
  });

  test("applies optimistic column changes without mutating original tasks", () => {
    const original = [task("blocked", -10, 1, "Blocked task", "blocked"), task("queued", 0, 2, "Queued task", "queued")];
    const unblocked = applyTaskColumn(original, { taskId: "blocked", targetColumn: "ready" });
    const backlogged = applyTaskColumn(original, { taskId: "queued", targetColumn: "backlog" });

    expect(original[0]?.status).toBe("blocked");
    expect(unblocked[0]?.status).toBe("queued");
    expect(unblocked[0]?.priority).toBe(0);
    expect(backlogged[1]?.status).toBe("queued");
    expect(backlogged[1]?.priority).toBe(-50);
  });

  test("selects an active session and summarizes log streams for the detail panel", () => {
    const detail = {
      ...task("task-a", 0, 1, "A task", "running"),
      sessions: [
        session("session-old", "failed", 1),
        session("session-active", "running", 2),
      ],
      artifacts: [],
      events: [],
      logStreams: [
        {
          id: "log-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-active",
          kind: "stdout",
          byteOffset: 128,
          lineCount: 2,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:01:00.000Z",
        },
      ],
    };

    expect(selectActiveSession(detail)?.id).toBe("session-active");
    expect(summarizeLogStream(detail.logStreams[0])).toBe("stdout · 2 lines · offset 128");
  });

  test("summarizes completed final response artifacts", () => {
    const summary = getTaskResultSummary({
      ...detailTask("completed"),
      artifacts: [
        {
          id: "artifact-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          kind: "final_response_url",
          uri: "https://example.test/result",
          title: "Final response URL",
          metadata: {},
          createdAt: "2026-05-13T00:00:00.000Z",
        },
      ],
    });

    expect(summary.kind).toBe("completed");
    expect(summary.finalResponseUrls).toEqual(["https://example.test/result"]);
  });

  test("summarizes blocked reason latest log and recovery command state", () => {
    const summary = getTaskResultSummary({
      ...detailTask("blocked"),
      events: [
        {
          id: "event-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          commandId: null,
          type: "session.startup.failed",
          payload: { reason: "startup failed" },
          createdAt: "2026-05-13T00:00:00.000Z",
        },
      ],
      logStreams: [
        {
          id: "log-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          kind: "stderr",
          byteOffset: 256,
          lineCount: 1,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:01:00.000Z",
        },
      ],
    });

    expect(summary.kind).toBe("blocked");
    expect(summary.body).toBe("startup failed");
    expect(summary.latestLogSummary).toBe("stderr · 1 line · offset 256");
    expect(summary.commandStates).toEqual(["Cancel available", "Retry unavailable"]);
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

function session(id: string, status: string, attemptNumber: number) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    attemptNumber,
    status,
    runtimeProvider: "fake",
    runtimeSessionId: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    finalResponseRecordedAt: null,
    lastHeartbeatAt: null,
    heartbeatStatus: "unknown",
    staleAt: null,
    lostAt: null,
  };
}

function detailTask(status: PublicTaskSummary["status"]) {
  return {
    ...task("task-a", 0, 1, "A task", status),
    sessions: [session("session-a", status === "completed" ? "succeeded" : "failed", 1)],
    artifacts: [],
    events: [],
    logStreams: [],
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
