import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTestBridgeCallbackServer, type BridgeCallbackEvent } from "@agent-pool/session-bridge";

import { createFakeRuntimeProvider, type RuntimeBridgeSessionOptions, type RuntimeClock } from "../src";

const clock: RuntimeClock = { now: () => new Date("2026-05-12T12:00:00.000Z") };
const sessionToken = { headerName: "x-agent-pool-session-token", token: "bridge-token" };

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("fake runtime bridge path", () => {
  test("drives the session bridge runner through ordered callbacks", async () => {
    const workspaceRoot = await tempWorkspace();
    const server = createTestBridgeCallbackServer({ sessionToken });
    const provider = createFakeRuntimeProvider({
      clock,
      fetch: server.fetch,
      scenario: {
        runtimeSessionId: "runtime_fake_bridge_1",
        output: [
          { stream: "stdout", text: "first line\n" },
          { stream: "stderr", text: "second line\n" },
        ],
        finalResponseText: "Fake runtime done. https://example.test/final",
        finalResponseMetadata: { source: "fake" },
        completionMetadata: { exitCode: 0 },
        cleanupReason: "test-complete",
      },
    });

    const handle = await provider.startSession({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      bridge: bridgeConfig(workspaceRoot),
    });

    expect(handle).toMatchObject({
      provider: "fake",
      sessionId: "runtime_fake_bridge_1",
      workspaceRoot,
    });
    expect(server.events.map((event) => event.kind)).toEqual([
      "heartbeat",
      "output",
      "output",
      "document",
      "document",
      "final_response",
      "completion",
      "cleanup",
    ]);
    expect(server.steeringPolls).toHaveLength(1);

    const outputEvents = server.events.filter(isOutput);
    expect(outputEvents).toEqual([
      expect.objectContaining({ stream: "stdout", sequence: 1, byteOffset: 0, text: "first line\n" }),
      expect.objectContaining({ stream: "stderr", sequence: 2, byteOffset: 11, text: "second line\n" }),
    ]);
    expect(server.events.filter(isDocument).map((event) => event.path)).toEqual([
      "agent-docs/fake-runtime-result.md",
      "shared-docs/fake-runtime-summary.json",
    ]);
    expect(server.events.find(isFinalResponse)).toMatchObject({
      text: "Fake runtime done. https://example.test/final",
      urlCandidates: ["https://example.test/final"],
      metadata: { source: "fake" },
    });
    expect(server.events.find(isCompletion)).toMatchObject({ metadata: { exitCode: 0 } });
    expect(server.events.find(isCleanup)).toMatchObject({ reason: "test-complete" });

    expect(provider.state.started[0]?.bridgeRun).toMatchObject({
      workspaceRoot,
      status: "success",
      result: {
        heartbeatPosted: true,
        outputPosted: 2,
        documentsDiscovered: 2,
        documentsPosted: 2,
        finalResponsePosted: true,
        completionPosted: true,
        failurePosted: false,
        cleanupPosted: true,
      },
    });
  });

  test("simulates runtime failure through failure and cleanup callbacks", async () => {
    const workspaceRoot = await tempWorkspace();
    const server = createTestBridgeCallbackServer({ sessionToken });
    const provider = createFakeRuntimeProvider({
      clock,
      fetch: server.fetch,
      scenario: {
        runtime: "failure",
        runtimeErrorMessage: "fake command failed",
        output: [{ stream: "system", text: "about to fail\n" }],
        documents: [],
        failureMetadata: { exitCode: 17 },
      },
    });

    await provider.startSession({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      bridge: bridgeConfig(workspaceRoot),
    });

    expect(server.events.map((event) => event.kind)).toEqual(["heartbeat", "output", "failure", "cleanup"]);
    expect(server.events.find(isFailure)).toMatchObject({
      errorMessage: "fake command failed",
      metadata: { exitCode: 17 },
    });
    expect(server.events.find(isCompletion)).toBeUndefined();
    expect(server.events.find(isFinalResponse)).toBeUndefined();
    expect(provider.state.started[0]?.bridgeRun).toMatchObject({
      status: "failure",
      result: {
        failurePosted: true,
        cleanupPosted: true,
      },
    });
  });

  test("keeps startup failure separate from bridge callbacks", async () => {
    const workspaceRoot = await tempWorkspace();
    const server = createTestBridgeCallbackServer({ sessionToken });
    const provider = createFakeRuntimeProvider({
      clock,
      fetch: server.fetch,
      scenario: {
        startup: "failure",
        startupErrorMessage: "sandbox image missing",
      },
    });

    await expect(
      provider.startSession({
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        bridge: bridgeConfig(workspaceRoot),
      }),
    ).rejects.toThrow("sandbox image missing");

    expect(server.events).toEqual([]);
    expect(provider.state.started).toEqual([]);
  });
});

function bridgeConfig(workspaceRoot: string): RuntimeBridgeSessionOptions {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://api.test",
    sessionToken,
    workspaceRoot,
  };
}

async function tempWorkspace(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "agent-pool-fake-runtime-"));
  tempRoots.push(path);
  return path;
}

function isOutput(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "output" } {
  return event.kind === "output";
}

function isDocument(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "document" } {
  return event.kind === "document";
}

function isFinalResponse(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "final_response" } {
  return event.kind === "final_response";
}

function isCompletion(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "completion" } {
  return event.kind === "completion";
}

function isFailure(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "failure" } {
  return event.kind === "failure";
}

function isCleanup(event: BridgeCallbackEvent): event is BridgeCallbackEvent & { readonly kind: "cleanup" } {
  return event.kind === "cleanup";
}
