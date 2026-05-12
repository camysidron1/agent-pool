import { describe, expect, test } from "bun:test";

import {
  SESSION_BRIDGE_PACKAGE_BOUNDARY,
  type BridgeCallbackEvent,
  type BridgeCleanupPayload,
  type BridgeCompletionPayload,
  type BridgeDocumentRegistration,
  type BridgeFailurePayload,
  type BridgeFinalResponsePayload,
  type BridgeHeartbeatPayload,
  type BridgeOutputChunk,
  type BridgeSessionOptions,
  type BridgeSteeringMessage,
} from "../src";

describe("session bridge package contract", () => {
  test("loads bridge-only public contract types and boundary marker", () => {
    const session: BridgeSessionOptions = {
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      callbackBaseUrl: "http://callback.test",
      sessionToken: {
        headerName: "x-agent-pool-session-token",
        token: "session-token",
      },
    };
    const heartbeat: BridgeHeartbeatPayload = {
      kind: "heartbeat",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    const output: BridgeOutputChunk = {
      kind: "output",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      stream: "stdout",
      sequence: 1,
      byteOffset: 0,
      text: "hello",
      observedAt: "2026-01-01T00:00:01.000Z",
    };
    const document: BridgeDocumentRegistration = {
      kind: "document",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      path: "agent-docs/result.md",
      title: "result.md",
      contentType: "text/markdown",
      sizeBytes: 100,
    };
    const finalResponse: BridgeFinalResponsePayload = {
      kind: "final_response",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      text: "Preview: https://example.test",
      urlCandidates: ["https://example.test"],
      observedAt: "2026-01-01T00:00:02.000Z",
    };
    const completion: BridgeCompletionPayload = {
      kind: "completion",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      observedAt: "2026-01-01T00:00:03.000Z",
    };
    const failure: BridgeFailurePayload = {
      kind: "failure",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      errorMessage: "runtime failed",
      observedAt: "2026-01-01T00:00:04.000Z",
    };
    const cleanup: BridgeCleanupPayload = {
      kind: "cleanup",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      reason: "session exited",
      observedAt: "2026-01-01T00:00:05.000Z",
    };
    const steering: BridgeSteeringMessage = {
      id: "steer_1",
      body: "continue",
    };
    const events: BridgeCallbackEvent[] = [heartbeat, output, document, finalResponse, completion, failure, cleanup];

    expect(SESSION_BRIDGE_PACKAGE_BOUNDARY).toEqual({
      bridgeOnly: true,
      importsBackendDb: false,
      importsWebUi: false,
      importsRuntimeProvider: false,
      includesRealProvider: false,
    });
    expect(events.map((event) => event.kind)).toEqual([
      "heartbeat",
      "output",
      "document",
      "final_response",
      "completion",
      "failure",
      "cleanup",
    ]);
    expect(steering.body).toBe("continue");
  });
});
