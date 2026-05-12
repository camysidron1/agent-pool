import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";
import { createOutboxPublisher } from "../src/outbox-publisher";

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

