import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { createCanonicalStateServices, migrateWebSandboxDatabase } from "../src";

describe("runtime sandbox lifecycle services", () => {
  test("creates runtime sandbox rows and finalizes successful sessions with snapshots before cleanup", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "Snapshot me" });

      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "e2b" })).toMatchObject({
        ok: true,
      });
      expect(
        services.reportStartupSucceeded({
          projectId: "project_a",
          sessionId: "session_1",
          runtimeSessionId: "sandbox_1",
        }),
      ).toMatchObject({ ok: true });
      expect(readRuntimeSandbox(database, "project_a", "session_1")).toMatchObject({
        provider: "e2b",
        provider_sandbox_id: "sandbox_1",
        status: "active",
        snapshot_status: "not_required",
      });

      expect(
        services.completeSession({
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        services.cleanupSession({
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          reason: "bridge cleanup completed",
        }),
      ).toMatchObject({ ok: true });
      expect(readRuntimeSandbox(database, "project_a", "session_1")).toMatchObject({
        status: "terminal",
        snapshot_status: "pending",
      });

      const claim = services.claimNextRuntimeSandboxFinalization({
        projectId: "project_a",
        cleanupGraceBefore: "2026-05-12T12:00:31.000Z",
      });
      expect(claim).toMatchObject({
        ok: true,
        finalization: {
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          provider: "e2b",
          providerSandboxId: "sandbox_1",
          snapshotRequired: true,
          snapshotEligibilityStatus: "clean",
          snapshotRiskReasons: ["clean"],
        },
        event: { type: "runtime_sandbox.finalization_claimed" },
      });
      if (!claim.ok) throw new Error("expected runtime sandbox finalization claim");

      const snapshot = services.reportRuntimeSandboxSnapshotCreated({
        projectId: "project_a",
        runtimeSandboxId: claim.finalization.id,
        providerSnapshotId: "snapshot_provider_1",
        expiresAt: "2026-05-13T12:00:31.000Z",
        metadata: { reason: "success" },
      });
      expect(snapshot).toMatchObject({
        ok: true,
        idempotent: false,
        snapshot: {
          projectId: "project_a",
          sessionId: "session_1",
          provider: "e2b",
          providerSnapshotId: "snapshot_provider_1",
          status: "ready",
          expiresAt: "2026-05-13T12:00:31.000Z",
        },
        event: { type: "session.snapshot.created" },
      });

      const cleanup = services.reportRuntimeSandboxCleanupSucceeded({
        projectId: "project_a",
        runtimeSandboxId: claim.finalization.id,
      });
      const duplicateCleanup = services.reportRuntimeSandboxCleanupSucceeded({
        projectId: "project_a",
        runtimeSandboxId: claim.finalization.id,
      });

      expect(cleanup).toMatchObject({
        ok: true,
        idempotent: false,
        runtimeSandbox: { id: claim.finalization.id, status: "cleanup_succeeded" },
        event: { type: "runtime_sandbox.cleanup_succeeded" },
      });
      expect(duplicateCleanup).toMatchObject({ ok: true, idempotent: true });
      expect(readRuntimeSandbox(database, "project_a", "session_1")).toMatchObject({
        status: "cleanup_succeeded",
        snapshot_status: "succeeded",
        snapshot_eligibility_status: "clean",
        snapshot_risk_reasons_json: "[\"clean\"]",
        cleanup_attempts: 1,
        snapshot_attempts: 1,
      });
      expect(readSnapshotMetadata(database, snapshot.snapshot.id)).toMatchObject({
        reason: "success",
        snapshotEligibilityStatus: "clean",
        snapshotRiskReasons: ["clean"],
      });
      expect(countRows(database, "session_snapshots")).toBe(1);
    } finally {
      database.close();
    }
  });

  test("failed sessions skip success snapshots and clean up provider sandboxes idempotently", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "Fail me" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "e2b" })).toMatchObject({
        ok: true,
      });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_1", runtimeSessionId: "sandbox_1" })).toMatchObject({
        ok: true,
      });

      expect(
        services.failSession({
          projectId: "project_a",
          taskId: "task_1",
          sessionId: "session_1",
          errorMessage: "runtime failed",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });

      const claim = services.claimNextRuntimeSandboxFinalization({
        projectId: "project_a",
        cleanupGraceBefore: "2026-05-12T12:00:31.000Z",
      });
      expect(claim).toMatchObject({
        ok: true,
        finalization: {
          sessionStatus: "failed",
          snapshotRequired: false,
          snapshotEligibilityStatus: "ineligible",
          snapshotRiskReasons: ["session-not-succeeded"],
        },
      });
      if (!claim.ok) throw new Error("expected runtime sandbox finalization claim");
      expect(
        services.reportRuntimeSandboxSnapshotCreated({
          projectId: "project_a",
          runtimeSandboxId: claim.finalization.id,
          providerSnapshotId: "snapshot_should_not_exist",
        }),
      ).toMatchObject({ ok: false, error: { code: "invalid_state" } });

      expect(
        services.reportRuntimeSandboxCleanupSucceeded({
          projectId: "project_a",
          runtimeSandboxId: claim.finalization.id,
        }),
      ).toMatchObject({ ok: true, runtimeSandbox: { status: "cleanup_succeeded" } });
      expect(readRuntimeSandbox(database, "project_a", "session_1")).toMatchObject({
        status: "cleanup_succeeded",
        snapshot_status: "skipped",
        snapshot_eligibility_status: "ineligible",
      });
      expect(countRows(database, "session_snapshots")).toBe(0);
    } finally {
      database.close();
    }
  });

  test("risk-classified successful sessions skip reusable snapshots but still clean up providers", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });

      for (const scenario of [
        {
          taskId: "task_egress",
          sessionId: "session_egress",
          sandboxId: "sandbox_egress",
          output: '{"type":"security","securityKind":"egress","allowed":false,"reason":"not_declared"}\n',
          expectedReason: "egress-denied",
          cleanup: true,
        },
        {
          taskId: "task_lockfile",
          sessionId: "session_lockfile",
          sandboxId: "sandbox_lockfile",
          output: '{"type":"security","securityKind":"postflight","lockfileChanged":true}\n',
          expectedReason: "lockfile-mutated",
          cleanup: true,
        },
        {
          taskId: "task_scrub",
          sessionId: "session_scrub",
          sandboxId: "sandbox_scrub",
          output: '{"type":"security","securityKind":"credentials-scrubbed","allowed":false}\n',
          expectedReason: "scrub-incomplete",
          cleanup: true,
        },
        {
          taskId: "task_grace",
          sessionId: "session_grace",
          sandboxId: "sandbox_grace",
          output: '{"type":"security","securityKind":"postflight","lockfileChanged":false}\n',
          expectedReason: "grace-timeout",
          cleanup: false,
        },
      ] as const) {
        createSucceededRuntimeSandbox(services, scenario);
        const claim = services.claimNextRuntimeSandboxFinalization({
          projectId: "project_a",
          cleanupGraceBefore: "2100-05-12T12:00:31.000Z",
        });
        expect(claim).toMatchObject({
          ok: true,
          finalization: {
            taskId: scenario.taskId,
            sessionId: scenario.sessionId,
            snapshotRequired: false,
            snapshotEligibilityStatus: "risk",
            snapshotRiskReasons: expect.arrayContaining([scenario.expectedReason]),
          },
        });
        if (!claim.ok) throw new Error("expected risk finalization claim");
        expect(
          services.reportRuntimeSandboxSnapshotCreated({
            projectId: "project_a",
            runtimeSandboxId: claim.finalization.id,
            providerSnapshotId: `snapshot_${scenario.sandboxId}`,
          }),
        ).toMatchObject({ ok: false, error: { code: "invalid_state" } });
        expect(
          services.reportRuntimeSandboxCleanupSucceeded({
            projectId: "project_a",
            runtimeSandboxId: claim.finalization.id,
          }),
        ).toMatchObject({ ok: true, runtimeSandbox: { status: "cleanup_succeeded" } });
        expect(readRuntimeSandbox(database, "project_a", scenario.sessionId)).toMatchObject({
          status: "cleanup_succeeded",
          snapshot_status: "skipped",
          snapshot_eligibility_status: "risk",
        });
      }

      expect(countRows(database, "session_snapshots")).toBe(0);
      expect(readSnapshotDecisionEvents(database)).toBe(4);
    } finally {
      database.close();
    }
  });

  test("validates source snapshots and tracks reuse without exposing public fork controls", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const snapshotId = createReadySnapshot(services, database);
      services.createTask({ id: "task_reuse", projectId: "project_a", title: "Reuse snapshot" });

      const claim = services.claimNextTask({
        projectId: "project_a",
        sessionId: "session_reuse",
        runtimeProvider: "e2b",
        sourceSnapshotId: snapshotId,
      });
      expect(claim).toMatchObject({
        ok: true,
        session: {
          id: "session_reuse",
          sourceSnapshot: {
            id: snapshotId,
            provider: "e2b",
            providerSnapshotId: "snapshot_provider_1",
          },
        },
      });
      expect(
        database
          .query<{ source_snapshot_id: string | null }, []>("SELECT source_snapshot_id FROM sessions WHERE id = 'session_reuse'")
          .get(),
      ).toEqual({ source_snapshot_id: snapshotId });
      expect(
        database
          .query<{ usage_count: number; last_used_at: string | null }, [string]>(
            "SELECT usage_count, last_used_at FROM session_snapshots WHERE id = ?",
          )
          .get(snapshotId),
      ).toMatchObject({ usage_count: 1, last_used_at: expect.any(String) });

      services.createTask({ id: "task_wrong_provider", projectId: "project_a", title: "Wrong provider" });
      expect(() =>
        services.claimNextTask({
          projectId: "project_a",
          sessionId: "session_wrong_provider",
          runtimeProvider: "fake",
          sourceSnapshotId: snapshotId,
        }),
      ).toThrow("source snapshot provider mismatch");

      database
        .query(
          `
            INSERT INTO session_snapshots (id, project_id, session_id, provider, status, provider_snapshot_id, expires_at)
            VALUES ('snapshot_expired', 'project_a', 'session_source', 'e2b', 'ready', 'snapshot_provider_expired', '2026-05-10T00:00:00.000Z')
          `,
        )
        .run();
      expect(() =>
        services.claimNextTask({
          projectId: "project_a",
          sessionId: "session_expired",
          runtimeProvider: "e2b",
          sourceSnapshotId: "snapshot_expired",
        }),
      ).toThrow("source snapshot is expired");

      services.createProject({ id: "project_b", slug: "project-b", name: "Project B" });
      services.createTask({ id: "task_cross_project", projectId: "project_b", title: "Cross project" });
      expect(() =>
        services.claimNextTask({
          projectId: "project_b",
          sessionId: "session_cross_project",
          runtimeProvider: "e2b",
          sourceSnapshotId: snapshotId,
        }),
      ).toThrow("source snapshot not found");
    } finally {
      database.close();
    }
  });

  test("matches clean compatible prewarmed snapshots and rejects stale lockfiles", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_source", projectId: "project_a", title: "Prewarm source" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_source", runtimeProvider: "e2b" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_source", runtimeSessionId: "sandbox_source" })).toMatchObject({
        ok: true,
      });

      const prewarmed = services.recordPrewarmedSnapshot({
        projectId: "project_a",
        sessionId: "session_source",
        provider: "e2b",
        providerSnapshotId: "provider_prewarmed_1",
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        lockfileDigest: "sha256:lock-a",
        packageAuditDigest: "sha256:pkg-a",
        expiresAt: "2030-05-12T12:00:00.000Z",
      });
      expect(prewarmed).toMatchObject({
        ok: true,
        snapshot: { providerSnapshotId: "provider_prewarmed_1", status: "ready" },
        event: { type: "session.snapshot.prewarmed_recorded" },
      });
      if (!prewarmed.ok) throw new Error("expected prewarmed snapshot");
      expect(readSnapshotMetadata(database, prewarmed.snapshot.id)).toMatchObject({
        snapshotPurpose: "prewarmed_base",
        lockfileDigest: "sha256:lock-a",
        packageAuditDigest: "sha256:pkg-a",
        credentialInjected: false,
      });

      services.createTask({
        id: "task_reuse",
        projectId: "project_a",
        title: "Reuse prewarm",
        runtimeSource: prewarmRuntimeSource("sha256:lock-a"),
        priority: 10,
      });
      services.createTask({
        id: "task_stale",
        projectId: "project_a",
        title: "Stale prewarm",
        runtimeSource: prewarmRuntimeSource("sha256:lock-b"),
        priority: 1,
      });

      const reuse = services.claimNextTask({ projectId: "project_a", sessionId: "session_reuse", runtimeProvider: "e2b" });
      expect(reuse).toMatchObject({
        ok: true,
        task: {
          runtimeSource: {
            lockfileDigest: "sha256:lock-a",
            packageAuditDigest: "sha256:pkg-a",
            preferPrewarmedSnapshot: true,
          },
        },
        session: {
          sourceSnapshot: {
            id: prewarmed.snapshot.id,
            provider: "e2b",
            providerSnapshotId: "provider_prewarmed_1",
          },
        },
      });
      expect(
        database.query<{ usage_count: number; last_used_at: string | null }, [string]>(
          "SELECT usage_count, last_used_at FROM session_snapshots WHERE id = ?",
        ).get(prewarmed.snapshot.id),
      ).toMatchObject({ usage_count: 1 });
      const stale = services.claimNextTask({ projectId: "project_a", sessionId: "session_stale", runtimeProvider: "e2b" });
      expect(stale).toMatchObject({
        ok: true,
        task: { id: "task_stale" },
        session: { sourceSnapshot: null },
      });
    } finally {
      database.close();
    }
  });

  test("claims expired snapshots for deletion and handles retryable provider delete failures", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const services = createCanonicalStateServices(database);
      const snapshotId = createReadySnapshot(services, database, { expiresAt: "2026-05-12T12:00:31.000Z" });

      const claim = services.claimNextExpiredSnapshotDeletion({
        projectId: "project_a",
        now: "2026-05-12T12:00:32.000Z",
      });
      expect(claim).toMatchObject({
        ok: true,
        snapshot: {
          id: snapshotId,
          projectId: "project_a",
          provider: "e2b",
          providerSnapshotId: "snapshot_provider_1",
        },
        event: { type: "session.snapshot.delete_claimed" },
      });
      if (!claim.ok) throw new Error("expected expired snapshot deletion claim");
      expect(readSnapshotStatus(database, snapshotId)).toEqual({ status: "delete_claimed" });

      expect(
        services.reportExpiredSnapshotDeletionFailed({
          projectId: "project_a",
          snapshotId,
          errorMessage: "delete failed",
        }),
      ).toMatchObject({ ok: true, snapshot: { id: snapshotId, status: "delete_failed" } });
      expect(readSnapshotStatus(database, snapshotId)).toEqual({ status: "delete_failed" });

      const retry = services.claimNextExpiredSnapshotDeletion({
        projectId: "project_a",
        now: "2026-05-12T12:00:33.000Z",
      });
      expect(retry).toMatchObject({ ok: true, snapshot: { id: snapshotId } });
      expect(
        services.reportExpiredSnapshotDeletionSucceeded({
          projectId: "project_a",
          snapshotId,
        }),
      ).toMatchObject({ ok: true, idempotent: false, snapshot: { id: snapshotId, status: "deleted" } });
      expect(
        services.reportExpiredSnapshotDeletionSucceeded({
          projectId: "project_a",
          snapshotId,
        }),
      ).toMatchObject({ ok: true, idempotent: true, snapshot: { id: snapshotId, status: "deleted" } });
    } finally {
      database.close();
    }
  });
});

function createReadySnapshot(
  services: ReturnType<typeof createCanonicalStateServices>,
  database: Database,
  options: { readonly expiresAt?: string } = {},
): string {
  services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
  services.createTask({ id: "task_source", projectId: "project_a", title: "Source task" });
  expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_source", runtimeProvider: "e2b" })).toMatchObject({ ok: true });
  expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_source", runtimeSessionId: "sandbox_source" })).toMatchObject({
    ok: true,
  });
  expect(
    services.completeSession({
      projectId: "project_a",
      taskId: "task_source",
      sessionId: "session_source",
      observedAt: "2026-05-12T12:00:00.000Z",
    }),
  ).toMatchObject({ ok: true });
  expect(
    services.cleanupSession({
      projectId: "project_a",
      taskId: "task_source",
      sessionId: "session_source",
      reason: "bridge cleanup completed",
    }),
  ).toMatchObject({ ok: true });
  const finalization = services.claimNextRuntimeSandboxFinalization({
    projectId: "project_a",
    cleanupGraceBefore: "2026-05-12T12:00:31.000Z",
  });
  if (!finalization.ok) throw new Error("expected runtime sandbox finalization claim");
  const snapshot = services.reportRuntimeSandboxSnapshotCreated({
    projectId: "project_a",
    runtimeSandboxId: finalization.finalization.id,
    providerSnapshotId: "snapshot_provider_1",
    expiresAt: options.expiresAt ?? "2030-05-13T12:00:31.000Z",
  });
  if (!snapshot.ok || !snapshot.snapshot) throw new Error("expected snapshot creation");
  expect(services.reportRuntimeSandboxCleanupSucceeded({ projectId: "project_a", runtimeSandboxId: finalization.finalization.id })).toMatchObject({
    ok: true,
  });
  expect(database.query<{ id: string }, []>("SELECT id FROM session_snapshots").get()).toEqual({ id: snapshot.snapshot.id });
  return snapshot.snapshot.id;
}

function prewarmRuntimeSource(lockfileDigest: string) {
  return {
    repositoryUrl: "https://github.com/example/tiny-fixture.git",
    baseRef: "main",
    taskBranchPrefix: "agent-pool/task",
    allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
    commandProfile: "agent-pool-bun-pr",
    lockfileDigest,
    packageAuditDigest: "sha256:pkg-a",
    preferPrewarmedSnapshot: true,
  };
}

function createSucceededRuntimeSandbox(
  services: ReturnType<typeof createCanonicalStateServices>,
  input: {
    readonly taskId: string;
    readonly sessionId: string;
    readonly sandboxId: string;
    readonly output: string;
    readonly cleanup: boolean;
  },
): void {
  services.createTask({ id: input.taskId, projectId: "project_a", title: input.taskId });
  expect(services.claimNextTask({ projectId: "project_a", sessionId: input.sessionId, runtimeProvider: "e2b" })).toMatchObject({ ok: true });
  expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: input.sessionId, runtimeSessionId: input.sandboxId })).toMatchObject({
    ok: true,
  });
  expect(
    services.recordSessionOutput({
      projectId: "project_a",
      taskId: input.taskId,
      sessionId: input.sessionId,
      stream: "system",
      sequence: 1,
      byteOffset: 0,
      text: input.output,
      observedAt: "2026-05-12T12:00:00.000Z",
    }),
  ).toMatchObject({ ok: true });
  expect(
    services.completeSession({
      projectId: "project_a",
      taskId: input.taskId,
      sessionId: input.sessionId,
      observedAt: "2026-05-12T12:00:00.000Z",
    }),
  ).toMatchObject({ ok: true });
  if (input.cleanup) {
    expect(
      services.cleanupSession({
        projectId: "project_a",
        taskId: input.taskId,
        sessionId: input.sessionId,
        reason: "bridge cleanup completed",
      }),
    ).toMatchObject({ ok: true });
  }
}

function createMigratedMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);
  return database;
}

function readRuntimeSandbox(database: Database, projectId: string, sessionId: string) {
  return database
    .query<
      {
        provider: string;
        provider_sandbox_id: string;
        status: string;
        snapshot_status: string;
        snapshot_eligibility_status: string;
        snapshot_risk_reasons_json: string;
        cleanup_attempts: number;
        snapshot_attempts: number;
      },
      [string, string]
    >(
      `
        SELECT provider, provider_sandbox_id, status, snapshot_status, snapshot_eligibility_status,
               snapshot_risk_reasons_json, cleanup_attempts, snapshot_attempts
        FROM runtime_sandboxes
        WHERE project_id = ? AND session_id = ?
      `,
    )
    .get(projectId, sessionId);
}

function readSnapshotMetadata(database: Database, snapshotId: string): Readonly<Record<string, unknown>> {
  const row = database.query<{ metadata_json: string }, [string]>("SELECT metadata_json FROM session_snapshots WHERE id = ?").get(snapshotId);
  return row ? JSON.parse(row.metadata_json) : {};
}

function readSnapshotDecisionEvents(database: Database): number {
  const row = database
    .query<{ count: number }, []>(
      "SELECT COUNT(*) AS count FROM events WHERE type = 'session.output' AND payload_json LIKE '%snapshot-decision%'",
    )
    .get();
  return row?.count ?? 0;
}

function readSnapshotStatus(database: Database, snapshotId: string) {
  return database.query<{ status: string }, [string]>("SELECT status FROM session_snapshots WHERE id = ?").get(snapshotId);
}

function countRows(database: Database, table: string): number {
  const row = database.query<{ count: number }, []>(`SELECT COUNT(*) AS count FROM ${table}`).get();
  return row?.count ?? 0;
}
