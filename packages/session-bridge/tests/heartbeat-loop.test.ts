import { describe, expect, test } from "bun:test";

import {
  createBridgeCallbackClient,
  createBridgeHeartbeatLoop,
  createTestBridgeCallbackServer,
  type BridgeScheduler,
  type BridgeSessionOptions,
} from "../src";

describe("bridge heartbeat loop", () => {
  test("posts heartbeat callbacks at deterministic scheduler cadence", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const scheduled: Array<() => void | Promise<unknown>> = [];
    const cleared: unknown[] = [];
    const scheduler: BridgeScheduler = {
      setInterval: (callback, intervalMs) => {
        scheduled.push(callback);
        return { id: "timer_1", intervalMs };
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    };
    const loop = createBridgeHeartbeatLoop({
      session,
      client: createBridgeCallbackClient({ session, fetch: server.fetch }),
      intervalMs: 5000,
      scheduler,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    expect(loop.running).toBe(false);
    loop.start();
    loop.start();

    expect(loop.running).toBe(true);
    expect(scheduled).toHaveLength(1);

    await scheduled[0]?.();
    loop.stop();
    loop.stop();

    expect(loop.running).toBe(false);
    expect(cleared).toEqual([{ id: "timer_1", intervalMs: 5000 }]);
    expect(server.events).toEqual([
      {
        kind: "heartbeat",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        observedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("surfaces failed heartbeat callbacks to a local failure sink", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const failures: unknown[] = [];
    const loop = createBridgeHeartbeatLoop({
      session: { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } },
      client: createBridgeCallbackClient({
        session: { ...session, sessionToken: { ...session.sessionToken, token: "wrong" } },
        fetch: server.fetch,
      }),
      intervalMs: 1000,
      clock: { now: () => new Date("2026-01-01T00:00:30.000Z") },
      onFailure: (failure) => {
        failures.push(failure);
      },
    });

    const result = await loop.tick();

    expect(result).toMatchObject({ ok: false, status: 403 });
    expect(failures).toMatchObject([
      {
        event: {
          kind: "heartbeat",
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          observedAt: "2026-01-01T00:00:30.000Z",
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
