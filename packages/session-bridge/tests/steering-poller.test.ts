import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createBridgeEventBuffer,
  createBridgeSteeringPoller,
  createTestBridgeCallbackServer,
  type BridgeSessionOptions,
} from "../src";

describe("bridge steering poller", () => {
  test("fetches normal steering and holds messages in order", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({
      sessionToken: session.sessionToken,
      steeringMessages: [
        { id: "steer_1", body: "first" },
        { id: "steer_2", body: "second" },
      ],
    });
    const poller = createBridgeSteeringPoller({
      session,
      client: createBridgeCallbackClient({ session, fetch: server.fetch }),
    });

    const first = await poller.pollOnce();
    const second = await poller.pollOnce();
    const drained = poller.drainHeld();

    expect(first).toEqual({
      ok: true,
      fetched: 2,
      held: [
        { id: "steer_1", body: "first" },
        { id: "steer_2", body: "second" },
      ],
      noWork: false,
    });
    expect(second).toEqual({
      ok: true,
      fetched: 0,
      held: [
        { id: "steer_1", body: "first" },
        { id: "steer_2", body: "second" },
      ],
      noWork: true,
    });
    expect(drained).toEqual([
      { id: "steer_1", body: "first" },
      { id: "steer_2", body: "second" },
    ]);
    expect(poller.heldMessages).toEqual([]);
  });

  test("records invalid-token polling failures through the event buffer contract", async () => {
    const session = testSession();
    const invalidSession = { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } };
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const eventBuffer = createBridgeEventBuffer();
    const poller = createBridgeSteeringPoller({
      session: invalidSession,
      client: createBridgeCallbackClient({ session: invalidSession, fetch: server.fetch }),
      eventBuffer,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const result = await poller.pollOnce();

    expect(result).toEqual({
      ok: false,
      status: 403,
      errorMessage: "invalid_session_token",
      held: [],
    });
    expect(eventBuffer.pending).toMatchObject([
      {
        id: "bridge_event_1",
        lastError: "invalid_session_token",
        event: {
          kind: "output",
          stream: "system",
          text: "steering poll failed: invalid_session_token",
          observedAt: "2026-01-01T00:00:00.000Z",
        },
      },
    ]);
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
