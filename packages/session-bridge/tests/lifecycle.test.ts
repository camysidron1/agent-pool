import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createBridgeEventBuffer,
  createBridgeLifecycleCapture,
  createTestBridgeCallbackServer,
  type BridgeSessionOptions,
} from "../src";

describe("bridge lifecycle callbacks", () => {
  test("posts completion failure and cleanup callbacks through session-token auth", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const client = createBridgeCallbackClient({ session, fetch: server.fetch });
    const lifecycle = createBridgeLifecycleCapture({
      session,
      client,
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
    });

    const completion = await lifecycle.captureCompletion({ metadata: { status: "ok" } });
    const failure = await lifecycle.captureFailure({
      errorMessage: "runtime failed",
      metadata: { exitCode: 1 },
    });
    const cleanup = await lifecycle.captureCleanup({ reason: "session exited" });

    expect(completion.callback.ok).toBe(true);
    expect(failure.callback.ok).toBe(true);
    expect(cleanup.callback.ok).toBe(true);
    expect(server.events).toEqual([
      {
        kind: "completion",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        observedAt: "2026-05-12T12:00:00.000Z",
        metadata: { status: "ok" },
      },
      {
        kind: "failure",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        errorMessage: "runtime failed",
        observedAt: "2026-05-12T12:00:00.000Z",
        metadata: { exitCode: 1 },
      },
      {
        kind: "cleanup",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        reason: "session exited",
        observedAt: "2026-05-12T12:00:00.000Z",
      },
    ]);
  });

  test("buffers failed lifecycle callbacks without importing runtime or backend code", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const invalidClient = createBridgeCallbackClient({
      session: {
        ...session,
        sessionToken: { ...session.sessionToken, token: "wrong-token" },
      },
      fetch: server.fetch,
    });
    const eventBuffer = createBridgeEventBuffer();
    const lifecycle = createBridgeLifecycleCapture({
      session,
      client: invalidClient,
      eventBuffer,
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
    });

    const result = await lifecycle.captureFailure({ errorMessage: "runtime failed" });

    expect(result.callback).toMatchObject({
      ok: false,
      status: 403,
      errorMessage: "invalid_session_token",
    });
    expect(eventBuffer.pending).toHaveLength(1);
    expect(eventBuffer.pending[0]?.event).toMatchObject({
      kind: "failure",
      errorMessage: "runtime failed",
    });
    expect(server.events).toEqual([]);
  });
});

function testSession(): BridgeSessionOptions {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://callback.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "session-token",
    },
  };
}
