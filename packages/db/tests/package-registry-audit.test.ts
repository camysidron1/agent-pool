import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("package registry authorization audit services", () => {
  test("authorizes globally allowed session-declared package scopes and persists audit rows", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      createScopedPackageTask(services);
      expect(services.claimNextTask({ projectId: "project_pkg", sessionId: "session_pkg" })).toMatchObject({ ok: true });

      const allowed = services.authorizePackageRegistryAccess({
        projectId: "project_pkg",
        sessionId: "session_pkg",
        registryHost: "registry.npmjs.org",
        packageName: "@agent-pool/sdk",
        requestedVersion: "^1.0.0",
        globalAllowedRegistryHosts: ["registry.npmjs.org"],
        metadata: { proxyToken: "must-redact", note: "install phase" },
      });

      expect(allowed).toMatchObject({
        ok: true,
        allowed: true,
        reason: "allowed",
        audit: {
          projectId: "project_pkg",
          taskId: "task_pkg",
          sessionId: "session_pkg",
          ecosystem: "npm",
          registryHost: "registry.npmjs.org",
          packageName: "@agent-pool/sdk",
          requestedVersion: "^1.0.0",
          decision: "allowed",
          metadata: { proxyToken: "[REDACTED]", note: "install phase" },
        },
      });
      expect(countRows(database, "package_registry_audits")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("denies undeclared packages and failed resolutions remain auditable", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      createScopedPackageTask(services);
      expect(services.claimNextTask({ projectId: "project_pkg", sessionId: "session_pkg" })).toMatchObject({ ok: true });

      const denied = services.authorizePackageRegistryAccess({
        projectId: "project_pkg",
        sessionId: "session_pkg",
        registryHost: "registry.npmjs.org",
        packageName: "left-pad",
        requestedVersion: "latest",
        globalAllowedRegistryHosts: ["registry.npmjs.org"],
      });
      expect(denied).toMatchObject({
        ok: true,
        allowed: false,
        reason: "package_scope_not_declared",
        audit: { decision: "denied", packageName: "left-pad" },
      });

      const failed = services.recordPackageRegistryAudit({
        projectId: "project_pkg",
        sessionId: "session_pkg",
        registryHost: "registry.npmjs.org",
        packageName: "@agent-pool/sdk",
        requestedVersion: "^9.9.9",
        decision: "failed",
        reason: "resolution failed upstream",
        metadata: { errorMessage: "not found" },
      });
      expect(failed).toMatchObject({
        ok: true,
        audit: {
          decision: "failed",
          reason: "resolution_failed_upstream",
          packageName: "@agent-pool/sdk",
          metadata: { errorMessage: "not found" },
        },
      });
      expect(countRows(database, "package_registry_audits")).toBe(2);
    } finally {
      database.close();
    }
  });
});

function createScopedPackageTask(services: ReturnType<typeof createCanonicalStateServices>): void {
  services.createProject({ id: "project_pkg", slug: "pkg", name: "Packages" });
  services.createTask({
    id: "task_pkg",
    projectId: "project_pkg",
    title: "Install scoped packages",
    runtimeSource: {
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      baseRef: "main",
      taskBranchPrefix: "agent-pool/task",
      allowedEgressDomains: ["github.com", "registry.npmjs.org"],
      allowedPackageScopes: ["@agent-pool/*"],
      commandProfile: "agent-pool-bun-pr",
    },
  });
}

function createMigratedMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);
  return database;
}

function countRows(database: Database, table: string): number {
  return database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get()?.count ?? 0;
}
