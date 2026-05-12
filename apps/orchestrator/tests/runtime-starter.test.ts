import { describe, expect, test } from "bun:test";

import { createRabbitMqAdapter } from "@agent-pool/queue";
import { createFakeRuntimeProvider } from "@agent-pool/runtime";

import { loadConfig } from "@agent-pool/config";
import type { TaskQueueConsumerBackend } from "../src/task-consumer";
import { runTaskQueueConsumerOnce } from "../src/task-consumer";
import { createRuntimeStarter } from "../src/runtime-starter";

describe("orchestrator runtime starter", () => {
  test("starts fake runtime from claimed task session and bridge config", async () => {
    const provider = createFakeRuntimeProvider({
      sessionIdFactory: () => "runtime_fake_1",
      clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
    });
    const starter = createRuntimeStarter({ provider, workspaceRoot: "/tmp/fake-workspace" });
    const result = await starter({
      projectId: "project_a",
      task: { id: "task_1", title: "Run fake" },
      session: {
        id: "session_1",
        bridge: bridgeConfig(),
      },
      wakeup: { taskId: "task_1" },
    });

    expect(result).toEqual({ ok: true, runtimeSessionId: "runtime_fake_1" });
    expect(provider.state.started).toHaveLength(1);
    expect(provider.state.started[0]?.request).toMatchObject({
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      workspaceRoot: "/tmp/fake-workspace",
      bridge: {
        callbackBaseUrl: "http://api.test",
        sessionToken: { headerName: "x-agent-pool-session-token", token: "bridge-token" },
      },
    });
  });

  test("reports deterministic fake startup failures as startup result failures", async () => {
    const starter = createRuntimeStarter({
      fake: {
        scenario: {
          startup: "failure",
          startupErrorMessage: "fake startup failed",
        },
      },
    });

    await expect(
      starter({
        projectId: "project_a",
        task: { id: "task_1" },
        session: { id: "session_1", bridge: bridgeConfig() },
        wakeup: {},
      }),
    ).resolves.toEqual({ ok: false, errorMessage: "fake startup failed" });
  });

  test("task consumer reports fake runtime startup success through existing backend API path", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const provider = createFakeRuntimeProvider({ sessionIdFactory: () => "runtime_fake_consumer" });
    const reports: unknown[] = [];
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_1", title: "Run fake" },
          session: { id: "session_1", bridge: bridgeConfig() },
          event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
          outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "project.project_a.control" },
        },
      }),
      reportStartupSucceeded: async (input) => {
        reports.push(input);
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            idempotent: false,
            session: { id: input.sessionId },
            task: { id: "task_1" },
            event: null,
            outbox: null,
          },
        };
      },
      reportStartupFailed: async () => {
        throw new Error("startup failure report should not be called");
      },
    };

    queue.publishProjectTaskHint("project_a", { taskId: "task_1" });

    const result = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      runtimeProvider: "fake",
      runtimeStarter: createRuntimeStarter({ provider }),
    });

    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      claimed: 1,
      startupsSucceeded: 1,
      startupsFailed: 0,
    });
    expect(reports).toEqual([
      {
        projectId: "project_a",
        sessionId: "session_1",
        runtimeSessionId: "runtime_fake_consumer",
      },
    ]);
    expect(provider.state.started[0]?.request.session).toMatchObject({ id: "session_1", bridge: bridgeConfig() });
  });
});

function bridgeConfig(): Readonly<Record<string, unknown>> {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://api.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "bridge-token",
    },
  };
}
