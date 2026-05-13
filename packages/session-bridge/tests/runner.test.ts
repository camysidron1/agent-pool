import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createBridgeRunner,
  createTestBridgeCallbackServer,
  type BridgeMockHarness,
  type BridgeSessionOptions,
} from "../src";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("bridge runner", () => {
  test("runs a deterministic composed bridge pass without a provider or API app", async () => {
    const session = testSession();
    const workspaceRoot = await createWorkspaceFixture();
    await mkdir(join(workspaceRoot, "agent-docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "agent-docs", "result.md"), "hello");
    const server = createTestBridgeCallbackServer({
      sessionToken: session.sessionToken,
      steeringMessages: [{ id: "steer_1", body: "continue" }],
    });
    const runner = createBridgeRunner({
      session,
      fetch: server.fetch,
      workspaceRoot,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    const result = await runner.runOnce({
      output: [{ stream: "stdout", text: "hello\n" }],
      finalResponseText: "Preview: https://example.test",
      finalResponseMetadata: { model: "test-model" },
    });

    expect(result).toEqual({
      heartbeatPosted: true,
      outputPosted: 1,
      documentsDiscovered: 1,
      documentsPosted: 1,
      steeringFetched: 1,
      steeringHandled: 1,
      steeringReported: 1,
      steeringReportFailures: 0,
      finalResponsePosted: true,
      completionPosted: false,
      failurePosted: false,
      cleanupPosted: false,
      bufferPending: 0,
      bufferDeadLetters: 0,
    });
    expect(server.events.map((event) => event.kind)).toEqual([
      "heartbeat",
      "output",
      "document",
      "output",
      "final_response",
    ]);
    expect(runner.harness.state.handledSteering).toEqual([{ id: "steer_1", body: "continue" }]);
    expect(server.steeringReports).toEqual([
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        steeringMessageId: "steer_1",
        status: "delivered",
        errorMessage: null,
      },
    ]);
  });

  test("exposes explicit start and stop lifecycle through the heartbeat loop", () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const scheduled: unknown[] = [];
    const cleared: unknown[] = [];
    const runner = createBridgeRunner({
      session,
      fetch: server.fetch,
      scheduler: {
        setInterval(callback, intervalMs) {
          scheduled.push({ callback, intervalMs });
          return { id: "timer_1", intervalMs };
        },
        clearInterval(handle) {
          cleared.push(handle);
        },
      },
      heartbeatIntervalMs: 1000,
    });

    runner.start();
    runner.start();
    runner.stop();
    runner.stop();

    expect(scheduled).toHaveLength(1);
    expect(cleared).toEqual([{ id: "timer_1", intervalMs: 1000 }]);
    expect(runner.running).toBe(false);
  });

  test("emits lifecycle callbacks through the composed runner", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const runner = createBridgeRunner({
      session,
      fetch: server.fetch,
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
    });

    const result = await runner.runOnce({
      output: [],
      completion: { metadata: { outcome: "done" } },
      failure: { errorMessage: "ignored test failure path" },
      cleanup: { reason: "finished" },
    });

    expect(result).toMatchObject({
      heartbeatPosted: true,
      outputPosted: 0,
      completionPosted: true,
      failurePosted: true,
      cleanupPosted: true,
      bufferPending: 0,
    });
    expect(server.events.map((event) => event.kind)).toEqual(["heartbeat", "completion", "failure", "cleanup"]);
  });

  test("reports failed steering apply results without importing backend services", async () => {
    const session = testSession();
    const server = createTestBridgeCallbackServer({
      sessionToken: session.sessionToken,
      steeringMessages: [{ id: "steer_fail", body: "apply this" }],
    });
    const failingHarness: BridgeMockHarness = {
      state: { generation: 1, handledSteering: [], restartCount: 0 },
      handleCommand: () => ({
        ok: false,
        errorMessage: "steering apply failed",
        output: [],
      }),
    };
    const runner = createBridgeRunner({
      session,
      fetch: server.fetch,
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
      harness: failingHarness,
    });

    const result = await runner.runOnce({ output: [] });

    expect(result).toMatchObject({
      steeringFetched: 1,
      steeringHandled: 1,
      steeringReported: 1,
      steeringReportFailures: 0,
    });
    expect(server.steeringReports).toEqual([
      {
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        steeringMessageId: "steer_fail",
        status: "failed",
        errorMessage: "steering apply failed",
      },
    ]);
  });
});

async function createWorkspaceFixture(): Promise<string> {
  const path = await mkdir(join(tmpdir(), `agent-pool-bridge-runner-${crypto.randomUUID()}`), { recursive: true });

  if (!path) throw new Error("failed to create temp workspace");
  cleanupPaths.push(path);
  return path;
}

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
