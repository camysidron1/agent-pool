import { describe, expect, test } from "bun:test";

import type { PublicTaskDetail } from "../src/api";
import {
  canPreviewArtifact,
  formatRawLogEntries,
  getArtifactHref,
  getArtifactStatus,
  getArtifactTitle,
  getRawLogEntries,
  groupArtifacts,
  shouldFollowRawLogScroll,
  summarizeLogFallback,
} from "../src/task-detail";

describe("web task detail helpers", () => {
  test("extracts raw output events in sequence order", () => {
    const entries = getRawLogEntries({
      ...detailTask(),
      events: [
        outputEvent("event-2", 2, "world\n"),
        { ...outputEvent("event-1", 1, "hello "), createdAt: "2026-05-13T00:00:00.000Z" },
        {
          id: "event-ignore",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          commandId: null,
          type: "session.output",
          payload: { stream: "stdout" },
          createdAt: "2026-05-13T00:02:00.000Z",
        },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["event-1", "event-2"]);
    expect(entries[0]).toMatchObject({ stream: "stdout", sequence: 1, text: "hello " });
    expect(formatRawLogEntries(entries)).toBe("hello world\n");
  });

  test("summarizes log metadata when raw event text is unavailable", () => {
    expect(
      summarizeLogFallback([
        {
          id: "log-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          kind: "stderr",
          byteOffset: 42,
          lineCount: 1,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:01:00.000Z",
        },
      ]),
    ).toEqual(["stderr · 1 line · offset 42"]);
  });

  test("pauses raw log following when the user scrolls away from the bottom", () => {
    expect(shouldFollowRawLogScroll({ scrollHeight: 1000, scrollTop: 776, clientHeight: 200 })).toBe(true);
    expect(shouldFollowRawLogScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })).toBe(false);
  });

  test("groups artifacts by detail-view order and extracts safe preview metadata", () => {
    const document = artifact("artifact-doc", "document", "agent-docs/result.md", {
      title: "result.md",
      metadata: { status: "ready", contentType: "text/markdown" },
    });
    const url = artifact("artifact-url", "final_response_url", "https://example.test/result");
    const file = artifact("artifact-file", "file", "blob://artifact", { metadata: { externalStatus: "syncing", url: "javascript:bad" } });

    const groups = groupArtifacts([url, file, document]);

    expect(groups.map((group) => group.kind)).toEqual(["document", "file", "final_response_url"]);
    expect(getArtifactTitle(document)).toBe("result.md");
    expect(getArtifactStatus(document)).toBe("ready");
    expect(getArtifactStatus(file)).toBe("syncing");
    expect(canPreviewArtifact(document)).toBe(true);
    expect(canPreviewArtifact(url)).toBe(false);
    expect(getArtifactHref(url)).toBe("https://example.test/result");
    expect(getArtifactHref(file)).toBeNull();
  });
});

function outputEvent(id: string, sequence: number, text: string) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    sessionId: "session-a",
    commandId: null,
    type: "session.output",
    payload: {
      stream: "stdout",
      sequence,
      text,
      observedAt: "2026-05-13T00:00:00.000Z",
    },
    createdAt: `2026-05-13T00:00:0${sequence}.000Z`,
  };
}

function detailTask(): PublicTaskDetail {
  return {
    id: "task-a",
    projectId: "project-a",
    displayId: 1,
    title: "Task A",
    description: null,
    status: "running",
    priority: 0,
    runtimeSource: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    latestSession: null,
    pendingCommands: [],
    sessions: [],
    artifacts: [],
    events: [],
    logStreams: [],
    steeringMessages: [],
    notes: [],
  };
}

function artifact(
  id: string,
  kind: string,
  uri: string,
  options: { readonly title?: string | null; readonly metadata?: Readonly<Record<string, unknown>> } = {},
) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    sessionId: "session-a",
    kind,
    uri,
    title: options.title ?? null,
    metadata: options.metadata ?? {},
    createdAt: "2026-05-13T00:00:00.000Z",
  };
}
