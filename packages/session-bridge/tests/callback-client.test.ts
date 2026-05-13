import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createTestBridgeCallbackServer,
  type BridgeCallbackEvent,
  type BridgeSessionOptions,
} from "../src";

describe("session bridge callback client", () => {
  test("posts typed callback events with session-token auth", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const client = createBridgeCallbackClient({ session, fetch: server.fetch });
    const events: BridgeCallbackEvent[] = [
      {
        kind: "heartbeat",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "output",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        stream: "stdout",
        sequence: 1,
        byteOffset: 0,
        text: "hello",
        observedAt: "2026-01-01T00:00:01.000Z",
      },
      {
        kind: "document",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        path: "agent-docs/result.md",
        title: "result.md",
      },
      {
        kind: "final_response",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        text: "Preview: https://example.test",
        urlCandidates: ["https://example.test"],
        observedAt: "2026-01-01T00:00:02.000Z",
      },
    ];

    const results = [];
    for (const event of events) {
      results.push(await client.postEvent(event));
    }

    expect(results.every((result) => result.ok)).toBe(true);
    expect(server.events).toEqual(events);
  });

  test("polls steering with session-token auth and records request shape", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({
      sessionToken: session.sessionToken,
      steeringMessages: [{ id: "steer_1", body: "continue" }],
    });
    const client = createBridgeCallbackClient({ session, fetch: server.fetch });

    const result = await client.pollSteering();

    expect(result).toEqual({ ok: true, messages: [{ id: "steer_1", body: "continue" }] });
    expect(server.steeringPolls).toEqual([
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
      },
    ]);
  });

  test("reports steering delivery with session-token auth and scope", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const client = createBridgeCallbackClient({ session, fetch: server.fetch });

    const result = await client.reportSteeringDelivery({
      steeringMessageId: "steer_1",
      status: "failed",
      errorMessage: "apply failed",
    });

    expect(result).toEqual({ ok: true, status: 200, body: { ok: true, accepted: true } });
    expect(server.steeringReports).toEqual([
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        steeringMessageId: "steer_1",
        status: "failed",
        errorMessage: "apply failed",
      },
    ]);
  });

  test("rejects missing and invalid session tokens deterministically", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const validEvent: BridgeCallbackEvent = {
      kind: "heartbeat",
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      observedAt: "2026-01-01T00:00:00.000Z",
    };
    const missing = await server.fetch("http://callback.test/callbacks/heartbeat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(validEvent),
    });
    const invalidClient = createBridgeCallbackClient({
      session: { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } },
      fetch: server.fetch,
    });
    const invalid = await invalidClient.postEvent(validEvent);

    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({ ok: false, error: "invalid_session_token", reason: "missing" });
    expect(invalid).toEqual({
      ok: false,
      status: 403,
      body: { ok: false, error: "invalid_session_token", reason: "invalid" },
      errorMessage: "invalid_session_token",
    });
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
