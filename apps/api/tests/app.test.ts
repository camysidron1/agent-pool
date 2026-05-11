import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API service skeleton", () => {
  test("health reports config and migrated database state", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.service).toBe("agent-pool-api");
      expect(body.authMode).toBe("test");
      expect(body.database.connected).toBe(true);
      expect(body.database.path).toEndWith("web-sandbox.db");
      expect(body.database.appliedMigrations).toBeGreaterThan(0);
    } finally {
      await close();
    }
  });

  test("metrics exposes service and database migration gauges", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/metrics`);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("agent_pool_api_info");
      expect(text).toContain("agent_pool_api_database_connected 1");
      expect(text).toContain("agent_pool_api_database_applied_migrations");
    } finally {
      await close();
    }
  });
});

async function startTestApi(): Promise<{ readonly baseUrl: string; readonly close: () => Promise<void> }> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-app-"));
  cleanupPaths.push(tempDir);
  const dbPath = join(tempDir, "db", "web-sandbox.db");
  const env = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: dbPath,
  };
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const app = createApiApp({ config, database });
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("test API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      database.close();
    },
  };
}
