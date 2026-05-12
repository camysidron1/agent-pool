import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import type { TaskQueueConsumerBackend, TaskRuntimeStartupRequest } from "../src/task-consumer";
import { runTaskQueueConsumerOnce } from "../src/task-consumer";

describe("orchestrator task queue consumer", () => {
  test("claims task wakeups and does not duplicate runtime startup for duplicate messages", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const starts: TaskRuntimeStartupRequest[] = [];
    const reports: unknown[] = [];
    let claims = 0;
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => {
        claims += 1;

        if (claims === 1) {
          return {
            ok: true,
            status: 200,
            body: {
              ok: true,
              claimed: true,
              task: { id: "task_1" },
              session: { id: "session_1" },
              event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
              outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "task.claimed" },
            },
          };
        }

        return {
          ok: true,
          status: 200,
          body: { ok: true, claimed: false, reason: "no_eligible_task" },
        };
      },
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
    queue.publishProjectTaskHint("project_a", { taskId: "task_1" });

    const result = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      runtimeProvider: "test-runtime",
      runtimeStarter: async (request) => {
        starts.push(request);
        return { ok: true, runtimeSessionId: "runtime_session_1" };
      },
    });

    expect(result).toEqual({
      queue: "project-tasks.project_a",
      processed: 2,
      acked: 2,
      retried: 0,
      deadLettered: 0,
      claimed: 1,
      noWork: 1,
      startupsSucceeded: 1,
      startupsFailed: 0,
    });
    expect(claims).toBe(2);
    expect(starts).toHaveLength(1);
    expect(starts[0]).toMatchObject({
      projectId: "project_a",
      task: { id: "task_1" },
      session: { id: "session_1" },
      wakeup: { taskId: "task_1" },
    });
    expect(reports).toEqual([
      {
        projectId: "project_a",
        sessionId: "session_1",
        runtimeSessionId: "runtime_session_1",
      },
    ]);
    expect(queue.publishedHints).toEqual([]);
  });

  test("reports startup failures through backend internal API without provider calls", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const failedReports: unknown[] = [];
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_2" },
          session: { id: "session_2" },
          event: { id: "event_2", projectId: "project_a", type: "task.claimed" },
          outbox: { id: "outbox_2", projectId: "project_a", eventId: "event_2", routingKey: "task.claimed" },
        },
      }),
      reportStartupSucceeded: async () => {
        throw new Error("startup success report should not be called");
      },
      reportStartupFailed: async (input) => {
        failedReports.push(input);
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            idempotent: false,
            session: { id: input.sessionId },
            task: { id: "task_2" },
            event: null,
            outbox: null,
          },
        };
      },
    };

    queue.publishProjectTaskHint("project_a", { taskId: "task_2" });

    const result = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      runtimeStarter: () => ({ ok: false, errorMessage: "startup unavailable" }),
    });

    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      retried: 0,
      deadLettered: 0,
      claimed: 1,
      noWork: 0,
      startupsSucceeded: 0,
      startupsFailed: 1,
    });
    expect(failedReports).toEqual([
      {
        projectId: "project_a",
        sessionId: "session_2",
        errorMessage: "startup unavailable",
      },
    ]);
  });
});
