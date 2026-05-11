import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Database } from "bun:sqlite";

import {
  CORE_PROJECT_TASK_SCHEMA_MIGRATION_ID,
  INITIAL_MIGRATION_ID,
  MIGRATION_TABLE_NAME,
  createDrizzleDatabase,
  createWebSandboxDatabaseConfig,
  initializeWebSandboxDatabase,
  migrateWebSandboxDatabase,
  openWebSandboxDatabase,
} from "../src";

describe("web/sandbox database migration harness", () => {
  test("initializes an empty net-new SQLite database path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-web-db-"));
    const dbPath = join(tempDir, "state", "web-sandbox.db");

    try {
      const result = initializeWebSandboxDatabase(createWebSandboxDatabaseConfig(dbPath));

      expect(result.path).toBe(dbPath);
      expect(result.applied).toEqual([
        {
          id: INITIAL_MIGRATION_ID,
          description: "Create web/sandbox migration metadata table",
        },
        {
          id: CORE_PROJECT_TASK_SCHEMA_MIGRATION_ID,
          description: "Create projects, tasks, and task dependency schema",
        },
      ]);

      const database = new Database(dbPath, { readonly: true, strict: true });
      try {
        const row = database.query<{ id: string }, []>(`SELECT id FROM ${MIGRATION_TABLE_NAME}`).get();

        expect(row).toEqual({ id: INITIAL_MIGRATION_ID });
      } finally {
        database.close();
      }
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("migration harness is idempotent", () => {
    const database = new Database(":memory:", { strict: true });

    try {
      const first = migrateWebSandboxDatabase(database);
      const second = migrateWebSandboxDatabase(database);

      expect(first.applied.map((migration) => migration.id)).toEqual([
        INITIAL_MIGRATION_ID,
        CORE_PROJECT_TASK_SCHEMA_MIGRATION_ID,
      ]);
      expect(second.applied).toEqual([]);
    } finally {
      database.close();
    }
  });

  test("exports a Drizzle client for Bun SQLite connections", () => {
    const database = openWebSandboxDatabase(createWebSandboxDatabaseConfig(":memory:"));

    try {
      const drizzleDb = createDrizzleDatabase(database);

      expect(drizzleDb).toBeDefined();
    } finally {
      database.close();
    }
  });

  test("refuses to open the existing TUI database path", () => {
    const home = readHomeDirectory() ?? "/tmp/home";
    const tuiDbPath = join(home, ".agent-pool", "data", "agent-pool.db");

    expect(() => openWebSandboxDatabase(createWebSandboxDatabaseConfig(tuiDbPath))).toThrow(
      "refusing to open existing agent-pool TUI database path",
    );
  });
});

function readHomeDirectory(): string | undefined {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env?.HOME;
}
