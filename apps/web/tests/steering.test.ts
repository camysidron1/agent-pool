import { describe, expect, test } from "bun:test";

import type {
  PublicApiClient,
  PublicPlannedUpload,
  PublicSessionSummary,
  PublicSteeringAttachmentReference,
  PublicSteeringMessageSummary,
  PublicTaskDetail,
} from "../src/api";
import {
  getSteeringAvailability,
  getVisibleSteeringMessages,
  plannedUploadToSteeringAttachment,
  shouldUseIncomingTaskDetail,
  submitSteeringDraft,
} from "../src/steering";

describe("web steering composer", () => {
  test("enables steering only for running tasks with a running active session", () => {
    const runningSession = session("session-active", "running");

    expect(getSteeringAvailability(detailTask("running", runningSession), runningSession)).toEqual({
      available: true,
      reason: null,
    });
    expect(getSteeringAvailability(detailTask("completed", session("session-done", "succeeded")), null)).toEqual({
      available: false,
      reason: "Steering is unavailable while the task is completed.",
    });
    expect(getSteeringAvailability(detailTask("running", session("session-starting", "starting")), session("session-starting", "starting"))).toEqual({
      available: false,
      reason: "Steering is unavailable while the session is starting.",
    });
  });

  test("submits trimmed steering with planned attachment references only", async () => {
    const runningSession = session("session-active", "running");
    const calls: unknown[] = [];
    const api: Pick<PublicApiClient, "planProjectUpload" | "steerSession"> = {
      async planProjectUpload(projectId, input) {
        calls.push({ kind: "plan", projectId, input });
        return {
          ok: true,
          upload: plannedUpload({
            key: `projects/${projectId}/${input.taskId}/${input.sessionId}/${input.fileName}`,
            localPath: `/tmp/raw-local-path/${input.fileName}`,
            contentType: input.contentType ?? null,
          }),
        };
      },
      async steerSession(projectId, taskId, sessionId, input) {
        calls.push({ kind: "steer", projectId, taskId, sessionId, input });
        return {
          ok: true,
          steering: {
            id: "steering-a",
            projectId,
            taskId,
            sessionId,
            commandId: "command-a",
            body: input.body,
            status: "queued",
            errorMessage: null,
            requestedBy: "operator-test",
            createdAt: "2026-05-13T00:00:00.000Z",
            deliveredAt: null,
            attachments: input.attachments ?? [],
          },
          command: {
            id: "command-a",
            projectId,
            taskId,
            sessionId,
            type: "steer",
            status: "queued",
            payload: {},
            errorMessage: null,
            requestedBy: "operator-test",
            createdAt: "2026-05-13T00:00:00.000Z",
            claimedAt: null,
            completedAt: null,
          },
          event: {
            id: "event-a",
            projectId,
            taskId,
            sessionId,
            commandId: "command-a",
            type: "steering.queued",
            payload: {},
            createdAt: "2026-05-13T00:00:00.000Z",
          },
          outbox: null,
          task: detailTask("running", runningSession),
          pendingCommands: [],
        };
      },
    };

    await submitSteeringDraft({
      api,
      projectId: "project-a",
      task: detailTask("running", runningSession),
      activeSession: runningSession,
      body: "  Run the focused test first.  ",
      files: [{ name: "context.txt", type: "text/plain" }],
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toEqual({
      kind: "plan",
      projectId: "project-a",
      input: {
        taskId: "task-a",
        sessionId: "session-active",
        fileName: "context.txt",
        contentType: "text/plain",
      },
    });
    expect(calls[1]).toEqual({
      kind: "steer",
      projectId: "project-a",
      taskId: "task-a",
      sessionId: "session-active",
      input: {
        body: "Run the focused test first.",
        attachments: [
          {
            key: "projects/project-a/task-a/session-active/context.txt",
            bucket: "agent-pool-web-sandbox",
            fileName: "context.txt",
            contentType: "text/plain",
          },
        ],
      },
    });
    expect(JSON.stringify(calls[1])).not.toContain("raw-local-path");
  });

  test("surfaces submit failures without planning attachments for unavailable sessions", async () => {
    const completedSession = session("session-done", "succeeded");
    const api: Pick<PublicApiClient, "planProjectUpload" | "steerSession"> = {
      async planProjectUpload() {
        throw new Error("plan should not be called");
      },
      async steerSession() {
        throw new Error("steer should not be called");
      },
    };

    await expect(
      submitSteeringDraft({
        api,
        projectId: "project-a",
        task: detailTask("completed", completedSession),
        activeSession: completedSession,
        body: "Please continue",
        files: [{ name: "context.txt", type: "text/plain" }],
      }),
    ).rejects.toThrow("Steering is unavailable while the task is completed.");
  });

  test("keeps queued and failed steering visible while hiding delivered steering", () => {
    const runningSession = session("session-active", "running");
    const visible = getVisibleSteeringMessages({
      ...detailTask("running", runningSession),
      steeringMessages: [
        steeringMessage("steer-queued", "queued", "2026-05-13T00:01:00.000Z"),
        steeringMessage("steer-delivered", "delivered", "2026-05-13T00:02:00.000Z", "2026-05-13T00:03:00.000Z"),
        steeringMessage("steer-failed", "failed", "2026-05-13T00:04:00.000Z", "2026-05-13T00:05:00.000Z"),
      ],
    });

    expect(visible.map((message) => [message.id, message.displayStatus])).toEqual([
      ["steer-queued", "Queued"],
      ["steer-failed", "Failed"],
    ]);
  });

  test("rejects stale steering detail responses after a newer applied update", () => {
    const runningSession = session("session-active", "running");
    const current = {
      ...detailTask("running", runningSession),
      steeringMessages: [
        steeringMessage("steer-a", "delivered", "2026-05-13T00:01:00.000Z", "2026-05-13T00:05:00.000Z"),
      ],
    };
    const stale = {
      ...detailTask("running", runningSession),
      steeringMessages: [steeringMessage("steer-a", "queued", "2026-05-13T00:01:00.000Z")],
    };
    const newer = {
      ...detailTask("running", runningSession),
      steeringMessages: [
        steeringMessage("steer-a", "failed", "2026-05-13T00:01:00.000Z", "2026-05-13T00:06:00.000Z"),
      ],
    };

    expect(shouldUseIncomingTaskDetail(current, stale)).toBe(false);
    expect(shouldUseIncomingTaskDetail(current, newer)).toBe(true);
  });

  test("keeps planned upload local paths out of steering attachment payloads", () => {
    const attachment = plannedUploadToSteeringAttachment(
      plannedUpload({ key: "projects/project-a/task-a/session-a/context.md", localPath: "/tmp/context.md" }),
      { name: "context.md", type: "text/markdown" },
    );

    expect(attachment).toEqual<PublicSteeringAttachmentReference>({
      key: "projects/project-a/task-a/session-a/context.md",
      bucket: "agent-pool-web-sandbox",
      fileName: "context.md",
      contentType: "text/markdown",
    });
    expect("localPath" in attachment).toBe(false);
  });
});

function plannedUpload(
  overrides: Partial<PublicPlannedUpload> & { readonly key: string; readonly localPath?: string | null },
): PublicPlannedUpload {
  return {
    adapter: "local",
    bucket: "agent-pool-web-sandbox",
    key: overrides.key,
    localPath: overrides.localPath ?? null,
    method: "local_path",
    contentType: overrides.contentType ?? null,
    expiresAt: null,
    headers: {},
    fields: {},
  };
}

function steeringMessage(
  id: string,
  status: PublicSteeringMessageSummary["status"],
  createdAt: string,
  deliveredAt: string | null = null,
): PublicSteeringMessageSummary {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    sessionId: "session-active",
    commandId: "command-a",
    body: "Keep going",
    status,
    errorMessage: status === "failed" ? "apply failed" : null,
    requestedBy: "operator-test",
    createdAt,
    deliveredAt,
    attachments: [{ key: "projects/project-a/task-a/session-active/context.txt", fileName: "context.txt" }],
  };
}

function detailTask(status: PublicTaskDetail["status"], activeSession: PublicSessionSummary): PublicTaskDetail {
  return {
    id: "task-a",
    projectId: "project-a",
    displayId: 1,
    title: "Active task",
    description: null,
    status,
    priority: 0,
    runtimeSource: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    latestSession: activeSession,
    pendingCommands: [],
    sessions: [activeSession],
    artifacts: [],
    events: [],
    logStreams: [],
    steeringMessages: [],
  };
}

function session(id: string, status: string): PublicSessionSummary {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    attemptNumber: 1,
    status,
    runtimeProvider: "fake",
    runtimeSessionId: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    finalResponseRecordedAt: null,
    lastHeartbeatAt: null,
    heartbeatStatus: "fresh",
    staleAt: null,
    lostAt: null,
  };
}
