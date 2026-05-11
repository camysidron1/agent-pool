import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { INITIAL_MIGRATION_ID, MIGRATION_TABLE_NAME } from "@agent-pool/db";

import {
  API_DATABASE_PATH_ENV,
  DEFAULT_API_DATABASE_RELATIVE_PATH,
  createApiDatabaseConfig,
  openApiDatabase,
  resolveApiDatabasePath,
} from "../src/database";

describe("API-owned web/sandbox database path", () => {
  test("defaults to a net-new web/sandbox path instead of the existing TUI database", () => {
    const home = join(tmpdir(), "agent-pool-api-home");
    const legacyTuiPath = join(home, ".agent-pool", "data", "agent-pool.db");

    expect(resolveApiDatabasePath({ HOME: home })).toBe(join(home, DEFAULT_API_DATABASE_RELATIVE_PATH));
    expect(resolveApiDatabasePath({ HOME: home })).not.toBe(legacyTuiPath);
  });

  test("rejects explicit attempts to reuse the existing TUI database path", () => {
    const home = join(tmpdir(), "agent-pool-api-home");
    const legacyTuiPath = join(home, ".agent-pool", "data", "agent-pool.db");

    expect(() =>
      createApiDatabaseConfig({
        HOME: home,
        [API_DATABASE_PATH_ENV]: legacyTuiPath,
      }),
    ).toThrow("refusing to use existing agent-pool TUI database path");
  });

  test("opens the default web/sandbox database without creating the legacy TUI database", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-default-db-"));
    const home = join(tempDir, "home");
    const expectedDefaultPath = join(home, DEFAULT_API_DATABASE_RELATIVE_PATH);
    const legacyTuiPath = join(home, ".agent-pool", "data", "agent-pool.db");

    try {
      const database = openApiDatabase({ HOME: home });

      try {
        expect(database.path).toBe(expectedDefaultPath);
      } finally {
        database.close();
      }

      expect(await Bun.file(expectedDefaultPath).exists()).toBe(true);
      expect(await Bun.file(legacyTuiPath).exists()).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });

  test("opens and migrates only the configured API database path", async () => {
    const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-db-"));
    const home = join(tempDir, "home");
    const dbPath = join(tempDir, "api-state", "web-sandbox.db");
    const legacyTuiPath = join(home, ".agent-pool", "data", "agent-pool.db");

    try {
      const database = openApiDatabase({
        HOME: home,
        [API_DATABASE_PATH_ENV]: dbPath,
      });

      try {
        const row = database.sqlite
          .query<{ id: string }, []>(`SELECT id FROM ${MIGRATION_TABLE_NAME}`)
          .get();

        expect(database.path).toBe(dbPath);
        expect(row).toEqual({ id: INITIAL_MIGRATION_ID });
      } finally {
        database.close();
      }

      expect(await Bun.file(dbPath).exists()).toBe(true);
      expect(await Bun.file(legacyTuiPath).exists()).toBe(false);
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }
  });
});
