import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import { createQueueDecisionPolicy } from "../src/queue-policy";
import type { TaskQueueConsumerBackend } from "../src/task-consumer";
import { runTaskQueueConsumerOnce } from "../src/task-consumer";

describe("orchestrator queue decision policy", () => {
  test("bounds transient retries and exposes deterministic attempt metadata", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const policy = createQueueDecisionPolicy({ maxAttempts: 2, retryDelayMs: 500 });
    let claims = 0;
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => {
        claims += 1;
        return { ok: false, status: 503, body: { ok: false, error: "backend_unavailable" } };
      },
      reportStartupSucceeded: async () => {
        throw new Error("startup success report should not be called");
      },
      reportStartupFailed: async () => {
        throw new Error("startup failure report should not be called");
      },
    };

    queue.publishProjectTaskHint("project_a", { taskId: "task_1" });

    const first = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      queuePolicy: policy,
      runtimeStarter: () => ({ ok: true }),
    });
    const second = await runTaskQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      queuePolicy: policy,
      runtimeStarter: () => ({ ok: true }),
    });

    expect(first).toMatchObject({ processed: 1, acked: 0, retried: 1, deadLettered: 0 });
    expect(second).toMatchObject({ processed: 1, acked: 0, retried: 0, deadLettered: 1 });
    expect(claims).toBe(2);
    expect(queue.pendingMessages).toEqual([]);
    expect(queue.deadLetters).toMatchObject([
      {
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { taskId: "task_1" },
        attempts: 2,
        lastRetryReason: "task_claim_failed",
        deadLetterReason: "max_attempts_exhausted:task_claim_failed",
      },
    ]);
  });

  test("dead-letters malformed claimed tasks with operator-visible reason metadata", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          task: { id: "task_1" },
          session: {},
          event: { id: "event_1", projectId: "project_a", type: "task.claimed" },
          outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "task.claimed" },
        },
      }),
      reportStartupSucceeded: async () => {
        throw new Error("startup success report should not be called");
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
      runtimeStarter: () => ({ ok: true }),
    });

    expect(result).toMatchObject({ processed: 1, acked: 0, retried: 0, deadLettered: 1 });
    expect(queue.deadLetters).toMatchObject([
      {
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { taskId: "task_1" },
        attempts: 1,
        deadLetterReason: "claimed_task_missing_session_id",
      },
    ]);
  });
});
