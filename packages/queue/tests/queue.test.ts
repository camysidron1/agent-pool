import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";

import { QUEUE_PACKAGE_BOUNDARY, createProjectQueueNames, createRabbitMqAdapter } from "../src";

describe("RabbitMQ queue adapter skeleton", () => {
  test("creates project task/control queue names without per-session queues", () => {
    const config = loadConfig({ AUTH_MODE: "test" }).rabbitmq;

    expect(createProjectQueueNames(config, "project_123")).toEqual({
      taskQueue: "project-tasks.project_123",
      controlQueue: "project-control.project_123",
    });
    expect(createProjectQueueNames(config, "project 123/session 456")).toEqual({
      taskQueue: "project-tasks.project-123-session-456",
      controlQueue: "project-control.project-123-session-456",
    });
    expect(QUEUE_PACKAGE_BOUNDARY.perSessionQueuesForMvp).toBe(false);
  });

  test("initializes deterministic RabbitMQ adapter skeleton without a broker", () => {
    const adapter = createRabbitMqAdapter(
      loadConfig({
        AUTH_MODE: "test",
        RABBITMQ_URL: "amqp://rabbitmq.test:5672",
        RABBITMQ_PROJECT_TASK_QUEUE_PREFIX: "tasks",
        RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX: "control",
      }).rabbitmq,
    );

    expect(adapter.kind).toBe("rabbitmq");
    expect(adapter.connected).toBe(false);
    expect(adapter.url).toBe("amqp://rabbitmq.test:5672");
    expect(adapter.projectQueues("project_a")).toEqual({
      taskQueue: "tasks.project_a",
      controlQueue: "control.project_a",
    });
    expect(adapter.enqueueHint("tasks.project_a", { taskId: "task_1" })).toEqual({
      queue: "tasks.project_a",
      payload: { taskId: "task_1" },
      enqueuedAt: "1970-01-01T00:00:00.000Z",
    });
  });
});
