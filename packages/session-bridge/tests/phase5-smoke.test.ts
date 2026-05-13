import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createBridgeCallbackClient,
  createBridgeRunner,
  createBridgeSteeringPoller,
  createTestBridgeCallbackServer,
  type BridgeCallbackEvent,
  type BridgeClock,
  type BridgeScheduler,
  type BridgeSessionOptions,
} from "../src";

describe("Phase 5 session bridge package smoke", () => {
  const tempRoots: string[] = [];

  afterEach(async () => {
    await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
    tempRoots.length = 0;
  });

  test("runs the deterministic bridge package scenario without external services", async () => {
    const workspaceRoot = await createSmokeWorkspace();
    tempRoots.push(workspaceRoot);

    const clock = fixedClock("2026-05-12T12:00:00.000Z");
    const scheduler = createManualScheduler();
    const session = smokeSession();
    const server = createTestBridgeCallbackServer({
      sessionToken: session.sessionToken,
      steeringMessages: [
        { id: "steer_1", body: "please continue", metadata: { source: "operator" } },
        { id: "interrupt_1", body: "restart cleanly", confirmedInterrupt: true },
      ],
    });

    const client = createBridgeCallbackClient({ session, fetch: server.fetch });
    const steeringPoller = createBridgeSteeringPoller({ session, client, clock });
    const steering = await steeringPoller.pollOnce();
    expect(steering).toMatchObject({ ok: true, fetched: 2, noWork: false });
    expect(steeringPoller.heldMessages.map((message) => message.id)).toEqual(["steer_1", "interrupt_1"]);
    expect(steeringPoller.drainHeld().map((message) => message.id)).toEqual(["steer_1", "interrupt_1"]);
    expect(steeringPoller.heldMessages).toEqual([]);

    const runner = createBridgeRunner({
      session,
      fetch: server.fetch,
      workspaceRoot,
      clock,
      scheduler,
      heartbeatIntervalMs: 7_500,
    });

    runner.start();
    expect(runner.running).toBe(true);
    expect(scheduler.intervals).toEqual([7_500]);
    await scheduler.tick(0);
    runner.stop();
    expect(runner.running).toBe(false);
    expect(scheduler.cleared).toBe(1);

    const result = await runner.runOnce({
      output: [
        { stream: "stdout", text: "alpha\n" },
        { stream: "stderr", text: "bravo\n" },
      ],
      finalResponseText: "Finished preview: https://example.test/result",
      finalResponseMetadata: { model: "mock", provider: "none" },
    });

    expect(result).toEqual({
      heartbeatPosted: true,
      outputPosted: 2,
      documentsDiscovered: 2,
      documentsPosted: 2,
      steeringFetched: 2,
      steeringHandled: 2,
      steeringReported: 2,
      steeringReportFailures: 0,
      finalResponsePosted: true,
      completionPosted: false,
      failurePosted: false,
      cleanupPosted: false,
      bufferPending: 0,
      bufferDeadLetters: 0,
    });
    expect(runner.harness.state.restartCount).toBe(1);
    expect(runner.harness.state.handledSteering.map((message) => message.id)).toEqual(["steer_1"]);

    const events = server.events;
    expect(events.map((event) => event.kind)).toEqual([
      "heartbeat",
      "heartbeat",
      "output",
      "output",
      "document",
      "document",
      "output",
      "output",
      "final_response",
    ]);

    const capturedOutput = events
      .filter((event): event is Extract<BridgeCallbackEvent, { readonly kind: "output" }> => event.kind === "output")
      .filter((event) => event.stream === "stdout" || event.stream === "stderr");
    expect(capturedOutput.map((event) => [event.sequence, event.byteOffset, event.text])).toEqual([
      [1, 0, "alpha\n"],
      [2, 6, "bravo\n"],
    ]);

    const documents = events.filter(
      (event): event is Extract<BridgeCallbackEvent, { readonly kind: "document" }> => event.kind === "document",
    );
    expect(documents.map((event) => event.path).sort()).toEqual(["agent-docs/result.md", "shared-docs/lesson.txt"]);

    const finalResponse = events.find(
      (event): event is Extract<BridgeCallbackEvent, { readonly kind: "final_response" }> =>
        event.kind === "final_response",
    );
    expect(finalResponse?.urlCandidates).toEqual(["https://example.test/result"]);
    expect(finalResponse?.metadata).toEqual({ model: "mock", provider: "none" });

    expect(server.steeringPolls).toHaveLength(2);
    expect(server.steeringPolls).toEqual([
      { projectId: "proj_phase5", taskId: "task_phase5", sessionId: "session_phase5" },
      { projectId: "proj_phase5", taskId: "task_phase5", sessionId: "session_phase5" },
    ]);
    expect(server.steeringReports).toEqual([
      {
        projectId: "proj_phase5",
        taskId: "task_phase5",
        sessionId: "session_phase5",
        steeringMessageId: "steer_1",
        status: "delivered",
        errorMessage: null,
      },
      {
        projectId: "proj_phase5",
        taskId: "task_phase5",
        sessionId: "session_phase5",
        steeringMessageId: "interrupt_1",
        status: "delivered",
        errorMessage: null,
      },
    ]);
  });

  test("rejects invalid session-token callbacks deterministically", async () => {
    const session = smokeSession();
    const server = createTestBridgeCallbackServer({ sessionToken: session.sessionToken });
    const invalidClient = createBridgeCallbackClient({
      session: {
        ...session,
        sessionToken: { ...session.sessionToken, token: "wrong-token" },
      },
      fetch: server.fetch,
    });

    const result = await invalidClient.postEvent({
      kind: "heartbeat",
      projectId: session.projectId,
      taskId: session.taskId,
      sessionId: session.sessionId,
      observedAt: "2026-05-12T12:00:00.000Z",
    });

    expect(result).toMatchObject({
      ok: false,
      status: 403,
      errorMessage: "invalid_session_token",
    });
    expect(server.events).toEqual([]);
  });
});

async function createSmokeWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "agent-pool-session-bridge-"));
  await mkdir(join(root, "agent-docs"), { recursive: true });
  await mkdir(join(root, "shared-docs"), { recursive: true });
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "agent-docs", "result.md"), "# Result\n", "utf8");
  await writeFile(join(root, "shared-docs", "lesson.txt"), "lesson\n", "utf8");
  await writeFile(join(root, "docs", "ignored.md"), "ignored\n", "utf8");
  return root;
}

function smokeSession(): BridgeSessionOptions {
  return {
    projectId: "proj_phase5",
    taskId: "task_phase5",
    sessionId: "session_phase5",
    callbackBaseUrl: "http://bridge.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "session-token",
    },
  };
}

function fixedClock(iso: string): BridgeClock {
  return { now: () => new Date(iso) };
}

function createManualScheduler(): BridgeScheduler & {
  readonly intervals: readonly number[];
  readonly cleared: number;
  readonly tick: (index: number) => Promise<void>;
} {
  const callbacks: Array<() => void | Promise<unknown>> = [];
  const intervals: number[] = [];
  let cleared = 0;

  return {
    get intervals(): readonly number[] {
      return [...intervals];
    },
    get cleared(): number {
      return cleared;
    },
    setInterval(callback, intervalMs): number {
      callbacks.push(callback);
      intervals.push(intervalMs);
      return callbacks.length - 1;
    },
    clearInterval(): void {
      cleared += 1;
    },
    async tick(index): Promise<void> {
      await callbacks[index]?.();
    },
  };
}
