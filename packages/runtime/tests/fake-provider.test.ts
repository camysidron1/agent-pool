import { describe, expect, test } from "bun:test";

import {
  createE2BRuntimeProvider,
  createFakeRuntimeProvider,
  createRuntimeProvider,
  RUNTIME_PACKAGE_BOUNDARY,
  type E2BRuntimeClient,
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
    expect(provider.capabilities).toEqual({
      start: true,
      stop: true,
      suspend: false,
      resume: false,
      fork: false,
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

  test("uses factory defaults and keeps docker provider unavailable in default CI", async () => {
    const fake = createRuntimeProvider({ kind: "fake" });
    const handle = await fake.startSession({ projectId: "project_a", taskId: "task_1" });

    expect(handle).toMatchObject({
      provider: "fake",
      sessionId: "fake-runtime-1",
      projectId: "project_a",
      taskId: "task_1",
    });

    const docker = createRuntimeProvider({ kind: "docker" });
    await expect(docker.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow(
      "docker runtime provider is not implemented in default CI",
    );
    expect(RUNTIME_PACKAGE_BOUNDARY).toMatchObject({
      fakeProviderIncluded: true,
      e2bProviderIncluded: true,
      defaultProviderUsesExternalServices: false,
      realE2BImplementationIncluded: true,
      e2bSdkImportedAtModuleLoad: false,
      dockerImplementationIncluded: false,
    });
  });

  test("selects E2B provider behind an injected client boundary without SDK side effects", async () => {
    const client: E2BRuntimeClient = {
      async createSandbox() {
        return { sandboxId: "sandbox_1" };
      },
      async runCommand() {
        return { ok: true };
      },
      async destroySandbox() {
        return undefined;
      },
    };
    const provider = createRuntimeProvider({
      kind: "e2b",
      e2b: {
        client,
        config: {
          apiKeyEnvName: "E2B_API_KEY",
          apiKeyConfigured: true,
        },
      },
    });

    expect(provider.kind).toBe("e2b");
    expect(provider.capabilities).toEqual({
      start: true,
      stop: true,
      suspend: false,
      resume: false,
      fork: false,
    });
    await expect(provider.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow(
      "e2b launch spec requires bridge session options",
    );
    expect(RUNTIME_PACKAGE_BOUNDARY.e2bSdkImportedAtModuleLoad).toBe(false);
  });

  test("reports E2B missing credential and client boundary errors deterministically", async () => {
    const missingCredential = createE2BRuntimeProvider({
      config: {
        apiKeyEnvName: "CUSTOM_E2B_KEY",
        apiKeyConfigured: false,
      },
      client: {
        async createSandbox() {
          return { sandboxId: "sandbox_1" };
        },
        async runCommand() {
          return { ok: true };
        },
        async destroySandbox() {
          return undefined;
        },
      },
    });
    const missingClient = createRuntimeProvider({
      kind: "e2b",
      e2b: {
        config: {
          apiKeyEnvName: "E2B_API_KEY",
          apiKeyConfigured: true,
        },
      },
    });

    await expect(missingCredential.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow(
      "CUSTOM_E2B_KEY is required to use the e2b runtime provider",
    );
    await expect(missingClient.startSession({ projectId: "project_a", taskId: "task_1" })).rejects.toThrow(
      "e2b runtime provider requires an injected E2B client",
    );
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
