import { describe, expect, test } from "bun:test";

import { parseSseEvents, projectEventsUrl, shouldRefreshBoardForEvent } from "../src/sse";
import type { PublicEventSummary } from "../src/api";

describe("web project SSE client", () => {
  test("builds an auth-compatible public project event URL", () => {
    expect(projectEventsUrl("https://agent-pool.example/", "project/id")).toBe(
      "https://agent-pool.example/api/public/projects/project%2Fid/events",
    );
  });

  test("parses complete SSE records and preserves partial buffers", () => {
    const parsed = parseSseEvents(
      `: connected\n\nid: evt-1\nevent: task.unblocked\ndata: ${JSON.stringify(event("evt-1", "task.unblocked"))}\n\nid: evt-2\nevent: task.`,
    );

    expect(parsed.events.map((item) => item.id)).toEqual(["evt-1"]);
    expect(parsed.remainder).toBe("id: evt-2\nevent: task.");
  });

  test("ignores malformed data while keeping later events", () => {
    const parsed = parseSseEvents(`data: not-json\n\ndata: ${JSON.stringify(event("evt-2", "session.started"))}\n\n`);

    expect(parsed.events.map((item) => item.id)).toEqual(["evt-2"]);
  });

  test("refreshes selected project task detail events", () => {
    expect(shouldRefreshBoardForEvent(event("evt-1", "task.claimed"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-2", "session.started"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-3", "command.queued"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-4", "steering.delivered"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-5", "artifact.created"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-6", "note.created"), "project-a")).toBe(true);
    expect(shouldRefreshBoardForEvent(event("evt-7", "task.claimed", "project-b"), "project-a")).toBe(false);
  });
});

function event(id: string, type: string, projectId = "project-a"): PublicEventSummary {
  return {
    id,
    projectId,
    taskId: "task-a",
    sessionId: null,
    commandId: null,
    type,
    payload: {},
    createdAt: "2026-05-13T00:00:00.000Z",
  };
}
