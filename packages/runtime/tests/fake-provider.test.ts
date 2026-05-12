import { describe, expect, test } from "bun:test";

import {
  createFakeRuntimeProvider,
  createRuntimeProvider,
  RUNTIME_PACKAGE_BOUNDARY,
  type RuntimeClock,
} from "../src";

describe("fake runtime provider", () => {
  test("starts and stops deterministic fake sessions without external providers", async () => {
    const clock: RuntimeClock = { now: () => new Date("2026-05-12T12:00:00.000Z") };
    const provider = createFakeRuntimeProvider({
      clock,
      sessionIdFactory: () => "runtime_session_fixed",
      workspaceRoot: "/tmp/fake-workspace",
      scenario: {
        metadata: { scenario: "happy" },
      },
    });

    const handle = await provider.startSession({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      task: { id: "task_1", title: "Run fake" },
      session: { id: "session_1" },
    });

    expect(handle).toEqual({
      provider: "fake",
      sessionId: "runtime_session_fixed",
      projectId: "project_a",
      taskId: "task_1",
      workspaceRoot: "/tmp/fake-workspace",
      startedAt: "2026-05-12T12:00:00.000Z",
      metadata: { scenario: "happy" },
    });
    expect(provider.state.started).toHaveLength(1);
    expect(provider.state.started[0]?.request).toMatchObject({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
    });
    expect(provider.state.active).toEqual([handle]);

    await provider.stopSession(handle);
    await provider.stopSession(handle);

    expect(provider.state.active).toEqual([]);
    expect(provider.state.stopped).toEqual([handle]);
  });

  test("uses factory defaults and keeps real providers unavailable in default CI", async () => {
    const fake = createRuntimeProvider({ kind: "fake" });
    const handle = await fake.startSession({ projectId: "project_a", taskId: "task_1" });

    expect(handle).toMatchObject({
      provider: "fake",
      sessionId: "fake-runtime-1",
      projectId: "project_a",
      taskId: "task_1",
    });

    const e2b = createRuntimeProvider({ kind: "e2b" });
    await expect(e2b.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow(
      "e2b runtime provider is not implemented in default CI",
    );
    expect(RUNTIME_PACKAGE_BOUNDARY).toMatchObject({
      fakeProviderIncluded: true,
      defaultProviderUsesExternalServices: false,
      realE2BImplementationIncluded: false,
      dockerImplementationIncluded: false,
    });
  });

  test("surfaces deterministic fake startup failures", async () => {
    const provider = createFakeRuntimeProvider({
      scenario: {
        startup: "failure",
        startupErrorMessage: "image unavailable",
      },
    });

    await expect(provider.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow("image unavailable");
    expect(provider.state.started).toEqual([]);
    expect(provider.state.active).toEqual([]);
  });
});
