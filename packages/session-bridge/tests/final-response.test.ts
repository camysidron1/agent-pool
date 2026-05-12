import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createBridgeEventBuffer,
  createBridgeFinalResponseCapture,
  createTestBridgeCallbackServer,
  extractFinalResponseUrls,
  type BridgeSessionOptions,
} from "../src";

describe("bridge final response capture", () => {
  test("posts final assistant response with metadata and URL candidates", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const capture = createBridgeFinalResponseCapture({
      session,
      client: createBridgeCallbackClient({ session, fetch: server.fetch }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const result = await capture.captureFromTranscript(
      [
        { role: "user", content: "ship it" },
        { role: "assistant", content: "Preview: https://example.test/app.", final: true },
      ],
      { model: "test-model" },
    );

    expect(result).toMatchObject({ idempotent: false, callback: { ok: true, status: 200 } });
    expect(server.events).toEqual([
      {
        kind: "final_response",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        text: "Preview: https://example.test/app.",
        metadata: { model: "test-model" },
        urlCandidates: ["https://example.test/app"],
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("treats identical final responses idempotently inside one bridge run", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const capture = createBridgeFinalResponseCapture({
      session,
      client: createBridgeCallbackClient({ session, fetch: server.fetch }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const first = await capture.capture({ text: "done", metadata: { attempt: 1 } });
    const duplicate = await capture.capture({ text: "done", metadata: { attempt: 1 } });

    expect(first.idempotent).toBe(false);
    expect(duplicate.idempotent).toBe(true);
    expect(duplicate.callback).toBeNull();
    expect(server.events).toHaveLength(1);
  });

  test("buffers failed final response callbacks after invalid token rejection", async () => {
    const session = testSession();
    const invalidSession = { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } };
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const buffer = createBridgeEventBuffer();
    const capture = createBridgeFinalResponseCapture({
      session: invalidSession,
      client: createBridgeCallbackClient({ session: invalidSession, fetch: server.fetch }),
      eventBuffer: buffer,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const result = await capture.capture({ text: "Preview: https://example.test" });

    expect(result.callback).toMatchObject({ ok: false, status: 403 });
    expect(buffer.pending).toMatchObject([
      {
        id: "bridge_event_1",
        attempts: 0,
        lastError: "invalid_session_token",
        event: { kind: "final_response", text: "Preview: https://example.test" },
      },
    ]);
  });

  test("extracts unique URL candidates from final text", () => {
    expect(extractFinalResponseUrls("See https://a.test, then https://b.test/path and https://a.test")).toEqual([
      "https://a.test",
      "https://b.test/path",
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
