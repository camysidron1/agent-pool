import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";

import {
  QUEUE_PACKAGE_BOUNDARY,
  createRabbitMqManagementHttpAdapter,
  createProjectQueueDeclarations,
  createProjectQueueNames,
  createRabbitMqAdapter,
} from "../src";

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
    expect(adapter.transport).toBe("memory");
    expect(adapter.url).toBe("amqp://rabbitmq.test:5672");
    expect(adapter.projectQueues("project_a")).toEqual({
      taskQueue: "tasks.project_a",
      controlQueue: "control.project_a",
    });
    expect(adapter.enqueueHint("tasks.project_a", { taskId: "task_1" })).toEqual({
      id: "queue_message_1",
      queue: "tasks.project_a",
      kind: "raw",
      payload: { taskId: "task_1" },
      enqueuedAt: "1970-01-01T00:00:00.000Z",
    });
  });

  test("declares durable project queues idempotently", () => {
    const config = loadConfig({ AUTH_MODE: "test" }).rabbitmq;
    const adapter = createRabbitMqAdapter(config);

    expect(createProjectQueueDeclarations(config, "project_a")).toEqual([
      {
        projectId: "project_a",
        kind: "task",
        queue: "project-tasks.project_a",
        durable: true,
      },
      {
        projectId: "project_a",
        kind: "control",
        queue: "project-control.project_a",
        durable: true,
      },
    ]);
    expect(adapter.declareProjectQueues("project_a")).toEqual(createProjectQueueDeclarations(config, "project_a"));
    expect(adapter.declareProjectQueues("project_a")).toEqual(createProjectQueueDeclarations(config, "project_a"));
    expect(adapter.declaredQueues).toEqual(createProjectQueueDeclarations(config, "project_a"));
  });

  test("publishes project task and control hints without per-session queues", () => {
    const adapter = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);

    const taskHint = adapter.publishProjectTaskHint("project_a", { projectId: "project_a", taskId: "task_1" });
    const controlHint = adapter.publishProjectControlHint("project_a", { projectId: "project_a", commandId: "command_1" });

    expect(taskHint).toEqual({
      id: "queue_message_1",
      queue: "project-tasks.project_a",
      kind: "task",
      payload: { projectId: "project_a", taskId: "task_1" },
      enqueuedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(controlHint).toEqual({
      id: "queue_message_2",
      queue: "project-control.project_a",
      kind: "control",
      payload: { projectId: "project_a", commandId: "command_1" },
      enqueuedAt: "1970-01-01T00:00:00.000Z",
    });
    expect(adapter.publishedHints.map((hint) => hint.queue)).toEqual(["project-tasks.project_a", "project-control.project_a"]);
    expect(adapter.publishedHints.map((hint) => hint.queue)).not.toContain("session-session_1");
  });

  test("drains deterministic in-memory queue messages with ack retry and dead-letter results", async () => {
    const adapter = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    adapter.publishProjectTaskHint("project_a", { id: "ack" });
    adapter.publishProjectTaskHint("project_a", { id: "retry" });
    adapter.publishProjectTaskHint("project_a", { id: "dead" });

    const result = await adapter.drainQueue<{ id: string }>("project-tasks.project_a", (message) => {
      if (message.payload.id === "retry") return { action: "retry", reason: "capacity_full", delayMs: 1000 };
      if (message.payload.id === "dead") return { action: "dead-letter", reason: "invalid_hint" };
      return { action: "ack" };
    });

    expect(result).toEqual({
      queue: "project-tasks.project_a",
      processed: 3,
      acked: 1,
      retried: 1,
      deadLettered: 1,
    });
    expect(adapter.publishedHints).toMatchObject([
      {
        id: "queue_message_4",
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { id: "retry" },
      },
    ]);
    expect(adapter.pendingMessages).toMatchObject([
      {
        id: "queue_message_4",
        attempts: 2,
        lastRetryReason: "capacity_full",
        availableAt: "1970-01-01T00:00:01.000Z",
      },
    ]);
    expect(adapter.deadLetters).toMatchObject([
      {
        id: "queue_message_3",
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { id: "dead" },
        attempts: 1,
        deadLetterReason: "invalid_hint",
        deadLetteredAt: "1970-01-01T00:00:00.000Z",
      },
    ]);
  });

  test("uses injected management HTTP transport for live RabbitMQ queue operations", async () => {
    const requests: Array<{ readonly method: string; readonly path: string; readonly auth: string | null; readonly body: unknown }> = [];
    const publishedPayloads: string[] = [];
    const adapter = createRabbitMqManagementHttpAdapter(
      loadConfig({
        AUTH_MODE: "test",
        RABBITMQ_URL: "amqp://rabbitmq.test:5672",
        RABBITMQ_MANAGEMENT_URL: "http://guest:guest@rabbitmq.test:15672",
      }).rabbitmq,
      {
        fetch: async (input, init) => {
          const request = new Request(input, init);
          const url = new URL(request.url);
          const body = await request.json().catch(() => null);
          requests.push({ method: request.method, path: url.pathname, auth: request.headers.get("authorization"), body });

          if (url.pathname === "/api/exchanges/%2F/amq.default/publish" && body && typeof body === "object") {
            publishedPayloads.push(String((body as { readonly payload?: unknown }).payload));
            return Response.json({ routed: true });
          }

          if (url.pathname.endsWith("/get")) {
            return Response.json(publishedPayloads.splice(0).map((payload) => ({ payload })));
          }

          return Response.json({});
        },
      },
    );

    expect(adapter.connected).toBe(true);
    expect(adapter.transport).toBe("management-http");
    expect(adapter.declareProjectQueues("project_a")).toEqual(createProjectQueueDeclarations(loadConfig({ AUTH_MODE: "test" }).rabbitmq, "project_a"));
    adapter.publishProjectTaskHint("project_a", { id: "ack" });
    adapter.publishProjectTaskHint("project_a", { id: "retry" });
    adapter.publishProjectTaskHint("project_a", { id: "dead" });
    await adapter.flush?.();

    const result = await adapter.drainQueue<{ id: string }>("project-tasks.project_a", (message) => {
      if (message.payload.id === "retry") return { action: "retry", reason: "capacity_full", delayMs: 1000 };
      if (message.payload.id === "dead") return { action: "dead-letter", reason: "invalid_hint" };
      return { action: "ack" };
    });

    expect(result).toEqual({
      queue: "project-tasks.project_a",
      processed: 3,
      acked: 1,
      retried: 1,
      deadLettered: 1,
    });
    expect(requests.map((request) => `${request.method} ${request.path}`)).toEqual([
      "PUT /api/queues/%2F/project-tasks.project_a",
      "PUT /api/queues/%2F/project-control.project_a",
      "POST /api/exchanges/%2F/amq.default/publish",
      "POST /api/exchanges/%2F/amq.default/publish",
      "POST /api/exchanges/%2F/amq.default/publish",
      "POST /api/queues/%2F/project-tasks.project_a/get",
      "POST /api/exchanges/%2F/amq.default/publish",
    ]);
    expect(requests.every((request) => request.auth === "Basic Z3Vlc3Q6Z3Vlc3Q=")).toBe(true);
    expect(adapter.pendingMessages).toMatchObject([
      {
        id: "queue_message_4",
        attempts: 2,
        lastRetryReason: "capacity_full",
      },
    ]);
    expect(adapter.deadLetters).toMatchObject([
      {
        id: "queue_message_3",
        queue: "project-tasks.project_a",
        kind: "task",
        payload: { id: "dead" },
        deadLetterReason: "invalid_hint",
      },
    ]);
  });
});
