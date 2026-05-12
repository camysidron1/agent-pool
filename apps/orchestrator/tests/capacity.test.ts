import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import type { ControlQueueConsumerBackend } from "../src/control-consumer";
import { runControlQueueConsumerOnce } from "../src/control-consumer";
import { createCapacityLimiter } from "../src/capacity";
import type { TaskQueueConsumerBackend } from "../src/task-consumer";
import { runTaskQueueConsumerOnce } from "../src/task-consumer";

describe("orchestrator capacity limiter", () => {
  test("tracks deterministic task startup capacity leases", () => {
    const limiter = createCapacityLimiter({ maxConcurrent: 1 });

    expect(limiter.maxConcurrent).toBe(1);
    expect(limiter.active).toBe(0);
    expect(limiter.available).toBe(true);

    const lease = limiter.acquire();

    expect(lease).not.toBeNull();
    expect(limiter.active).toBe(1);
    expect(limiter.available).toBe(false);
    expect(limiter.acquire()).toBeNull();

    lease?.release();
    lease?.release();

    expect(limiter.active).toBe(0);
    expect(limiter.available).toBe(true);
  });

  test("capacity-full task wakeups retry without claiming tasks or hot-looping", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const limiter = createCapacityLimiter({ maxConcurrent: 1 });
    const heldLease = limiter.acquire();
    let claims = 0;
    const backend: TaskQueueConsumerBackend = {
      claimNextTask: async () => {
        claims += 1;
        throw new Error("claimNextTask should not be called when capacity is full");
      },
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
      capacityLimiter: limiter,
      capacityRetryDelayMs: 250,
      runtimeStarter: () => ({ ok: true }),
    });

    expect(result).toEqual({
      queue: "project-tasks.project_a",
      processed: 1,
      acked: 0,
      retried: 1,
      deadLettered: 0,
      claimed: 0,
      noWork: 0,
      startupsSucceeded: 0,
      startupsFailed: 0,
    });
    expect(claims).toBe(0);
    expect(queue.publishedHints).toMatchObject([
      {
        id: "queue_message_2",
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { taskId: "task_1" },
      },
    ]);
    expect(limiter.active).toBe(1);

    heldLease?.release();
  });

  test("control queue handling remains available while task startup capacity is full", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const limiter = createCapacityLimiter({ maxConcurrent: 1 });
    const heldLease = limiter.acquire();
    const backend: ControlQueueConsumerBackend = {
      claimNextCommand: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          command: { id: "command_1", type: "cancel" },
          event: { id: "event_1", projectId: "project_a", type: "command.claimed" },
          outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "command.claimed" },
        },
      }),
      reportCommandStarted: async (input) => commandReport(input.commandId),
      reportCommandSucceeded: async (input) => commandReport(input.commandId),
      reportCommandFailed: async () => {
        throw new Error("command failure report should not be called");
      },
    };

    queue.publishProjectControlHint("project_a", { commandId: "command_1" });

    const result = await runControlQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      commandHandler: () => ({ ok: true }),
    });

    expect(limiter.available).toBe(false);
    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      retried: 0,
      deadLettered: 0,
      claimed: 1,
      commandsSucceeded: 1,
    });

    heldLease?.release();
  });
});

function commandReport(commandId: string) {
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      idempotent: false,
      command: { id: commandId },
      event: null,
      outbox: null,
    },
  } as const;
}
