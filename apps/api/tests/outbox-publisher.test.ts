import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";
import { createOutboxPublisher, type PublishQueuedOutboxResult } from "../src/outbox-publisher";
import { createOutboxPublisherLoop, type OutboxPublisherLoopScheduler } from "../src/outbox-publisher-loop";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API outbox publisher", () => {
  test("publishes queued task and control outbox rows to project queues", async () => {
    const { database, queue, close } = await createHarness();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });
      const command = services.requestCommand({ id: "command_1", projectId: "project_a", taskId: "task_1", type: "cancel" });
      expect(command).toMatchObject({ ok: true });

      const result = createOutboxPublisher({ database, queue }).publishQueued();

      expect(result).toEqual({
        scanned: 2,
        published: [
          {
            outboxId: expect.any(String),
            projectId: "project_a",
            queue: "project-tasks.project_a",
            queueKind: "task",
          },
          {
            outboxId: expect.any(String),
            projectId: "project_a",
            queue: "project-control.project_a",
            queueKind: "control",
          },
        ],
        failed: [],
      });
      expect(queue.publishedHints).toMatchObject([
        {
          queue: "project-tasks.project_a",
          kind: "task",
          payload: { eventType: "task.created", routingKey: "project.project_a.events" },
        },
        {
          queue: "project-control.project_a",
          kind: "control",
          payload: { eventType: "command.queued", routingKey: "project.project_a.control" },
        },
      ]);
      expect(
        database.sqlite
          .query<{ status: string; attempts: number; published_at: string | null; last_error: string | null }, []>(
            "SELECT status, attempts, published_at, last_error FROM outbox ORDER BY rowid",
          )
          .all(),
      ).toEqual([
        { status: "published", attempts: 1, published_at: expect.any(String), last_error: null },
        { status: "published", attempts: 1, published_at: expect.any(String), last_error: null },
      ]);
      expect(createOutboxPublisher({ database, queue }).publishQueued()).toEqual({
        scanned: 0,
        published: [],
        failed: [],
      });
    } finally {
      await close();
    }
  });

  test("records publish failures without a live broker", async () => {
    const { database, close } = await createHarness();
    const queue = {
      ...createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq),
      publishProjectTaskHint() {
        throw new Error("broker unavailable");
      },
    };

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });

      const result = createOutboxPublisher({ database, queue }).publishQueued();

      expect(result).toEqual({
        scanned: 1,
        published: [],
        failed: [{ outboxId: expect.any(String), projectId: "project_a", error: "broker unavailable" }],
      });
      expect(
        database.sqlite
          .query<{ status: string; attempts: number; last_error: string | null }, []>(
            "SELECT status, attempts, last_error FROM outbox",
          )
          .get(),
      ).toEqual({ status: "failed", attempts: 1, last_error: "broker unavailable" });
    } finally {
      await close();
    }
  });

  test("async publisher flushes live queue operations before marking outbox rows published", async () => {
    const { database, close } = await createHarness();
    let flushes = 0;
    const queue = {
      ...createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq),
      async flush() {
        flushes += 1;
      },
    };

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });

      const result = await createOutboxPublisher({ database, queue }).publishQueuedAsync();

      expect(result).toMatchObject({
        scanned: 1,
        published: [{ projectId: "project_a", queue: "project-tasks.project_a", queueKind: "task" }],
        failed: [],
      });
      expect(flushes).toBe(1);
      expect(
        database.sqlite
          .query<{ status: string; attempts: number; last_error: string | null }, []>(
            "SELECT status, attempts, last_error FROM outbox",
          )
          .get(),
      ).toEqual({ status: "published", attempts: 1, last_error: null });
    } finally {
      await close();
    }
  });

  test("async publisher records failed live queue flushes", async () => {
    const { database, close } = await createHarness();
    const queue = {
      ...createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq),
      async flush() {
        throw new Error("management API unavailable");
      },
    };

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });

      const result = await createOutboxPublisher({ database, queue }).publishQueuedAsync();

      expect(result).toEqual({
        scanned: 1,
        published: [],
        failed: [{ outboxId: expect.any(String), projectId: "project_a", error: "management API unavailable" }],
      });
      expect(
        database.sqlite
          .query<{ status: string; attempts: number; last_error: string | null }, []>(
            "SELECT status, attempts, last_error FROM outbox",
          )
          .get(),
      ).toEqual({ status: "failed", attempts: 1, last_error: "management API unavailable" });
    } finally {
      await close();
    }
  });

  test("outbox publisher loop publishes on ticks and shuts down its scheduler", async () => {
    const intervals: number[] = [];
    const scheduledCallbacks: Array<() => void | Promise<void>> = [];
    const clearedHandles: unknown[] = [];
    const scheduler: OutboxPublisherLoopScheduler = {
      setInterval(callback, intervalMs) {
        intervals.push(intervalMs);
        scheduledCallbacks.push(callback);
        return `interval-${intervals.length}`;
      },
      clearInterval(handle) {
        clearedHandles.push(handle);
      },
    };
    let publishCalls = 0;
    const loop = createOutboxPublisherLoop({
      publisher: {
        async publishQueuedAsync() {
          publishCalls += 1;
          return {
            scanned: publishCalls,
            published: [
              {
                outboxId: `outbox_${publishCalls}`,
                projectId: "project_a",
                queue: "project-tasks.project_a",
                queueKind: "task",
              },
            ],
            failed: [],
          };
        },
      },
      intervalMs: 25,
      scheduler,
    });

    expect(loop.state).toMatchObject({ running: false, ticks: 0, failures: 0, inFlight: false });

    loop.start();
    loop.start();
    const first = await loop.tick();

    expect(intervals).toEqual([25]);
    expect(scheduledCallbacks).toHaveLength(1);
    expect(first).toMatchObject({ scanned: 1, failed: [] });
    expect(loop.state).toMatchObject({ running: true, ticks: 1, failures: 0, inFlight: false });
    expect(loop.state.lastResult).toMatchObject({ scanned: 1, published: [{ outboxId: "outbox_1" }] });

    loop.stop();
    loop.stop();

    expect(clearedHandles).toEqual(["interval-1"]);
    expect(loop.state.running).toBe(false);
  });

  test("outbox publisher loop records tick failures without overlapping publishes", async () => {
    let resolvePublish: ((result: PublishQueuedOutboxResult) => void) | null = null;
    let publishCalls = 0;
    const errors: unknown[] = [];
    const loop = createOutboxPublisherLoop({
      publisher: {
        publishQueuedAsync() {
          publishCalls += 1;
          return new Promise<PublishQueuedOutboxResult>((resolve) => {
            resolvePublish = resolve;
          });
        },
      },
      intervalMs: 25,
      onError(error) {
        errors.push(error);
      },
    });

    const first = loop.tick();
    const second = loop.tick();
    expect(publishCalls).toBe(1);
    expect(loop.state.inFlight).toBe(true);
    resolvePublish?.({
      scanned: 1,
      published: [],
      failed: [],
    });
    await Promise.all([first, second]);
    expect(loop.state).toMatchObject({ ticks: 1, failures: 0, inFlight: false });

    const failingLoop = createOutboxPublisherLoop({
      publisher: {
        async publishQueuedAsync() {
          throw new Error("publisher crashed");
        },
      },
      intervalMs: 25,
      onError(error) {
        errors.push(error);
      },
    });

    await expect(failingLoop.tick()).resolves.toBeNull();
    expect(failingLoop.state).toMatchObject({
      ticks: 1,
      failures: 1,
      inFlight: false,
      lastError: "publisher crashed",
    });
    expect(errors).toHaveLength(1);
  });
});

async function createHarness(): Promise<{
  readonly database: ReturnType<typeof openApiDatabase>;
  readonly queue: ReturnType<typeof createRabbitMqAdapter>;
  readonly close: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-outbox-publisher-"));
  cleanupPaths.push(tempDir);
  const env = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: join(tempDir, "db", "web-sandbox.db"),
  };
  const database = openApiDatabase(env);
  const queue = createRabbitMqAdapter(loadConfig(env).rabbitmq);

  return {
    database,
    queue,
    async close() {
      database.close();
    },
  };
}
