import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import { createApiBackendServices } from "../src/backend-services";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API backend services", () => {
  test("declares durable project task and control queues when creating backend-owned projects", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-backend-services-"));
    cleanupPaths.push(tempDir);
    const env = {
      AUTH_MODE: "test",
      HOME: join(tempDir, "home"),
      [API_DATABASE_PATH_ENV]: join(tempDir, "db", "web-sandbox.db"),
    };
    const database = openApiDatabase(env);
    const queue = createRabbitMqAdapter(loadConfig(env).rabbitmq);

    try {
      const services = createApiBackendServices({ database, queue });
      const result = services.createProjectWithQueues({
        id: "project_a",
        slug: "project-a",
        name: "Project A",
      });
      const duplicate = queue.declareProjectQueues("project_a");

      expect(result.project).toEqual({ id: "project_a", slug: "project-a", name: "Project A" });
      expect(result.queues).toEqual([
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
      expect(duplicate).toEqual(result.queues);
      expect(queue.declaredQueues).toEqual(result.queues);
      expect(database.sqlite.query<{ id: string }, []>("SELECT id FROM projects WHERE id = 'project_a'").get()).toEqual({
        id: "project_a",
      });
    } finally {
      database.close();
    }
  });
});

