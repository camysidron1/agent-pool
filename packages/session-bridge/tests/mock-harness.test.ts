import { describe, expect, test } from "bun:test";

import { createBridgeMockHarness, type BridgeSessionOptions } from "../src";

describe("bridge mock harness", () => {
  test("accepts normal steering without restarting", () => {
    const harness = createBridgeMockHarness({
      session: testSession(),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const result = harness.handleCommand({
      kind: "steering",
      message: { id: "steer_1", body: "continue" },
    });

    expect(result).toMatchObject({
      ok: true,
      output: [{ stream: "system", sequence: 1, byteOffset: 0, text: "steering accepted: continue" }],
    });
    expect(harness.state).toEqual({
      generation: 1,
      handledSteering: [{ id: "steer_1", body: "continue" }],
      restartCount: 0,
      restartContexts: [],
    });
  });

  test("confirmed interrupt restarts mock harness state deterministically", () => {
    const harness = createBridgeMockHarness({
      session: testSession(),
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const rejected = harness.handleCommand({
      kind: "interrupt",
      message: { id: "interrupt_1", body: "stop", confirmedInterrupt: false },
    });
    const restarted = harness.handleCommand({
      kind: "interrupt",
      message: {
        id: "interrupt_2",
        body: "stop",
        confirmedInterrupt: true,
        metadata: { restartContext: { kind: "confirmed_interrupt_restart", steeringContext: { messages: [{ id: "steer_1" }] } } },
      },
    });

    expect(rejected).toMatchObject({
      ok: false,
      errorMessage: "interrupt requires confirmation",
      output: [{ text: "interrupt rejected: confirmation required" }],
    });
    expect(restarted).toMatchObject({
      ok: true,
      output: [{ text: "mock harness restarted after interrupt: interrupt_2" }],
    });
    expect(harness.state.generation).toBe(2);
    expect(harness.state.restartCount).toBe(1);
    expect(harness.state.restartContexts).toEqual([
      { kind: "confirmed_interrupt_restart", steeringContext: { messages: [{ id: "steer_1" }] } },
    ]);
  });

  test("unsupported mock harness commands return structured failures", () => {
    const harness = createBridgeMockHarness({ session: testSession() });

    const result = harness.handleCommand({ kind: "pause" } as never);

    expect(result).toMatchObject({
      ok: false,
      errorMessage: "unsupported mock harness command",
      output: [{ text: "unsupported mock harness command" }],
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
