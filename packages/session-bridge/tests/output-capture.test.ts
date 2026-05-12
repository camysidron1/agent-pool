import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createBridgeOutputCapture,
  createTestBridgeCallbackServer,
  type BridgeSessionOptions,
} from "../src";

describe("bridge output capture", () => {
  test("posts output chunks in capture order with sequence and byte offsets", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const capture = createBridgeOutputCapture({
      session,
      client: createBridgeCallbackClient({ session, fetch: server.fetch }),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    await capture.capture("stdout", "hello\n");
    await capture.capture("stderr", "error\n");
    await capture.capture("system", "done");

    expect(capture.nextSequence).toBe(4);
    expect(capture.byteOffset).toBe(16);
    expect(server.events).toEqual([
      {
        kind: "output",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        stream: "stdout",
        sequence: 1,
        byteOffset: 0,
        text: "hello\n",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "output",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        stream: "stderr",
        sequence: 2,
        byteOffset: 6,
        text: "error\n",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        kind: "output",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        stream: "system",
        sequence: 3,
        byteOffset: 12,
        text: "done",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("surfaces failed output callbacks without a real PTY or process", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const failures: unknown[] = [];
    const invalidSession = { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } };
    const capture = createBridgeOutputCapture({
      session: invalidSession,
      client: createBridgeCallbackClient({ session: invalidSession, fetch: server.fetch }),
      clock: { now: () => new Date("2026-01-01T00:00:01.000Z") },
      onFailure: (failure) => failures.push(failure),
    });

    const result = await capture.capture("combined", "hello");

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(failures).toMatchObject([
      {
        event: {
          kind: "output",
          stream: "combined",
          sequence: 1,
          byteOffset: 0,
          text: "hello",
          observedAt: "2026-01-01T00:00:01.000Z",
        },
        result: { ok: false, status: 403 },
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
