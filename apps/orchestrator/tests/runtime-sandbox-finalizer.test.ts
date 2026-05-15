import { describe, expect, test } from "bun:test";

import type { RuntimeProvider, RuntimeSessionHandle, RuntimeSnapshotHandle } from "@agent-pool/runtime";

import type { RuntimeSandboxFinalizerBackend } from "../src/runtime-sandbox-finalizer";
import { runRuntimeSandboxFinalizerOnce } from "../src/runtime-sandbox-finalizer";

describe("runtime sandbox finalizer", () => {
  test("snapshots successful sessions before provider cleanup", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      finalization: {
        id: "runtime_sandbox_1",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        sessionStatus: "succeeded",
        provider: "e2b",
        providerSandboxId: "sandbox_1",
        sourceSnapshotId: null,
        snapshotRequired: true,
      },
    });
    const provider = createProvider(calls);

    const result = await runRuntimeSandboxFinalizerOnce({
      backend,
      runtimeProvider: provider,
      clock: { now: () => new Date("2026-05-14T00:00:00.000Z") },
      snapshotTtlMs: 1_000,
    });

    expect(result).toMatchObject({
      ok: true,
      finalizationClaimed: true,
      snapshotCreated: true,
      cleanupSucceeded: true,
    });
    expect(calls).toEqual([
      "claimFinalization",
      "snapshot:sandbox_1",
      "reportSnapshotCreated:runtime_sandbox_1:snapshot_sandbox_1:2026-05-14T00:00:01.000Z",
      "stop:sandbox_1",
      "reportCleanupSucceeded:runtime_sandbox_1",
    ]);
  });

  test("skips snapshots for failed terminal sessions and still cleans up provider sandboxes", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      finalization: {
        id: "runtime_sandbox_failed",
        projectId: "project_a",
        taskId: "task_failed",
        sessionId: "session_failed",
        sessionStatus: "failed",
        provider: "e2b",
        providerSandboxId: "sandbox_failed",
        sourceSnapshotId: null,
        snapshotRequired: false,
      },
    });
    const provider = createProvider(calls);

    const result = await runRuntimeSandboxFinalizerOnce({ backend, runtimeProvider: provider });

    expect(result).toMatchObject({
      ok: true,
      finalizationClaimed: true,
      snapshotCreated: false,
      cleanupSucceeded: true,
    });
    expect(calls).toEqual(["claimFinalization", "stop:sandbox_failed", "reportCleanupSucceeded:runtime_sandbox_failed"]);
  });

  test("skips snapshots for risk-classified successful sessions", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      finalization: {
        id: "runtime_sandbox_risk",
        projectId: "project_a",
        taskId: "task_risk",
        sessionId: "session_risk",
        sessionStatus: "succeeded",
        provider: "e2b",
        providerSandboxId: "sandbox_risk",
        sourceSnapshotId: null,
        snapshotRequired: false,
        snapshotEligibilityStatus: "risk",
        snapshotRiskReasons: ["egress-denied"],
      },
    });
    const provider = createProvider(calls);

    const result = await runRuntimeSandboxFinalizerOnce({ backend, runtimeProvider: provider });

    expect(result).toMatchObject({
      ok: true,
      finalizationClaimed: true,
      snapshotCreated: false,
      cleanupSucceeded: true,
    });
    expect(calls).toEqual(["claimFinalization", "stop:sandbox_risk", "reportCleanupSucceeded:runtime_sandbox_risk"]);
  });

  test("records snapshot failures and does not leave the provider sandbox running forever", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      finalization: {
        id: "runtime_sandbox_1",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        sessionStatus: "succeeded",
        provider: "e2b",
        providerSandboxId: "sandbox_1",
        sourceSnapshotId: null,
        snapshotRequired: true,
      },
    });
    const provider = createProvider(calls, {
      createSnapshot: async () => {
        calls.push("snapshot:sandbox_1");
        throw new Error("snapshot failed");
      },
    });

    const result = await runRuntimeSandboxFinalizerOnce({ backend, runtimeProvider: provider });

    expect(result).toMatchObject({
      ok: false,
      finalizationClaimed: true,
      snapshotFailed: true,
      cleanupSucceeded: true,
    });
    expect(calls).toEqual([
      "claimFinalization",
      "snapshot:sandbox_1",
      "reportSnapshotFailed:runtime_sandbox_1:snapshot failed",
      "stop:sandbox_1",
      "reportCleanupSucceeded:runtime_sandbox_1",
    ]);
  });

  test("reports retryable provider cleanup failures", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      finalization: {
        id: "runtime_sandbox_failed",
        projectId: "project_a",
        taskId: "task_failed",
        sessionId: "session_failed",
        sessionStatus: "failed",
        provider: "e2b",
        providerSandboxId: "sandbox_failed",
        sourceSnapshotId: null,
        snapshotRequired: false,
      },
    });
    const provider = createProvider(calls, {
      stopSession: async () => {
        calls.push("stop:sandbox_failed");
        throw new Error("provider cleanup failed");
      },
    });

    const result = await runRuntimeSandboxFinalizerOnce({ backend, runtimeProvider: provider });

    expect(result).toMatchObject({
      ok: false,
      finalizationClaimed: true,
      cleanupFailed: true,
    });
    expect(calls).toEqual([
      "claimFinalization",
      "stop:sandbox_failed",
      "reportCleanupFailed:runtime_sandbox_failed:provider cleanup failed",
    ]);
  });

  test("deletes expired snapshots when no runtime sandbox finalization is claimable", async () => {
    const calls: string[] = [];
    const backend = createBackend(calls, {
      expiredSnapshot: {
        id: "snapshot_1",
        projectId: "project_a",
        provider: "e2b",
        providerSnapshotId: "snapshot_provider_1",
      },
    });
    const provider = createProvider(calls);

    const result = await runRuntimeSandboxFinalizerOnce({ backend, runtimeProvider: provider });

    expect(result).toMatchObject({
      ok: true,
      expiredSnapshotClaimed: true,
      expiredSnapshotDeleted: true,
    });
    expect(calls).toEqual(["claimFinalization", "claimExpiredSnapshot", "deleteSnapshot:snapshot_provider_1", "reportSnapshotDeleted:snapshot_1"]);
  });
});

function createProvider(
  calls: string[],
  overrides: Partial<Pick<RuntimeProvider, "createSnapshot" | "deleteSnapshot" | "stopSession">> = {},
): RuntimeProvider {
  return {
    kind: "e2b",
    capabilities: {
      start: true,
      stop: true,
      suspend: false,
      resume: false,
      fork: false,
      snapshot: true,
      deleteSnapshot: true,
      startFromSnapshot: true,
    },
    async startSession() {
      throw new Error("finalizer should not start sessions");
    },
    async stopSession(handle: RuntimeSessionHandle) {
      if (overrides.stopSession) return overrides.stopSession(handle);
      calls.push(`stop:${handle.sessionId}`);
    },
    async createSnapshot(handle: RuntimeSessionHandle) {
      if (overrides.createSnapshot) return overrides.createSnapshot(handle);
      calls.push(`snapshot:${handle.sessionId}`);
      return { provider: "e2b", snapshotId: `snapshot_${handle.sessionId}` };
    },
    async deleteSnapshot(snapshot: RuntimeSnapshotHandle) {
      if (overrides.deleteSnapshot) return overrides.deleteSnapshot(snapshot);
      calls.push(`deleteSnapshot:${snapshot.snapshotId}`);
    },
  };
}

function createBackend(
  calls: string[],
  options: {
    readonly finalization?: {
      readonly id: string;
      readonly projectId: string;
      readonly taskId: string;
      readonly sessionId: string;
      readonly sessionStatus: "succeeded" | "failed" | "canceled";
      readonly provider: string;
      readonly providerSandboxId: string;
      readonly sourceSnapshotId: string | null;
      readonly snapshotRequired: boolean;
      readonly snapshotEligibilityStatus?: "unknown" | "clean" | "ineligible" | "risk";
      readonly snapshotRiskReasons?: readonly string[];
    };
    readonly expiredSnapshot?: {
      readonly id: string;
      readonly projectId: string;
      readonly provider: string;
      readonly providerSnapshotId: string;
    };
  } = {},
): RuntimeSandboxFinalizerBackend {
  return {
    async claimRuntimeSandboxFinalization() {
      calls.push("claimFinalization");
      return options.finalization
        ? {
            ok: true,
            status: 200,
            body: {
              ok: true,
              claimed: true,
              finalization: options.finalization,
              event: { id: "event_finalization", projectId: options.finalization.projectId, type: "runtime_sandbox.finalization_claimed" },
              outbox: {
                id: "outbox_finalization",
                projectId: options.finalization.projectId,
                eventId: "event_finalization",
                routingKey: "project.project_a.control",
              },
            },
          }
        : { ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_runtime_sandbox_finalization" } };
    },
    async reportRuntimeSandboxSnapshotCreated(input) {
      calls.push(`reportSnapshotCreated:${input.runtimeSandboxId}:${input.providerSnapshotId}:${input.expiresAt}`);
      return {
        ok: true,
        status: 200,
        body: { ok: true, idempotent: false, snapshot: { id: "snapshot_record_1" }, event: null, outbox: null },
      };
    },
    async reportRuntimeSandboxSnapshotFailed(input) {
      calls.push(`reportSnapshotFailed:${input.runtimeSandboxId}:${input.errorMessage}`);
      return { ok: true, status: 200, body: { ok: true, idempotent: false, snapshot: null, event: null, outbox: null } };
    },
    async reportRuntimeSandboxCleanupSucceeded(input) {
      calls.push(`reportCleanupSucceeded:${input.runtimeSandboxId}`);
      return {
        ok: true,
        status: 200,
        body: { ok: true, idempotent: false, runtimeSandbox: { id: input.runtimeSandboxId }, event: null, outbox: null },
      };
    },
    async reportRuntimeSandboxCleanupFailed(input) {
      calls.push(`reportCleanupFailed:${input.runtimeSandboxId}:${input.errorMessage}`);
      return {
        ok: true,
        status: 200,
        body: { ok: true, idempotent: false, runtimeSandbox: { id: input.runtimeSandboxId }, event: null, outbox: null },
      };
    },
    async claimExpiredSnapshotDeletion() {
      calls.push("claimExpiredSnapshot");
      return options.expiredSnapshot
        ? {
            ok: true,
            status: 200,
            body: {
              ok: true,
              claimed: true,
              snapshot: options.expiredSnapshot,
              event: { id: "event_snapshot_delete", projectId: options.expiredSnapshot.projectId, type: "session.snapshot.delete_claimed" },
              outbox: {
                id: "outbox_snapshot_delete",
                projectId: options.expiredSnapshot.projectId,
                eventId: "event_snapshot_delete",
                routingKey: "project.project_a.control",
              },
            },
          }
        : { ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_expired_snapshot" } };
    },
    async reportExpiredSnapshotDeleted(input) {
      calls.push(`reportSnapshotDeleted:${input.snapshotId}`);
      return {
        ok: true,
        status: 200,
        body: { ok: true, idempotent: false, snapshot: { id: input.snapshotId }, event: null, outbox: null },
      };
    },
    async reportExpiredSnapshotDeleteFailed(input) {
      calls.push(`reportSnapshotDeleteFailed:${input.snapshotId}:${input.errorMessage}`);
      return {
        ok: true,
        status: 200,
        body: { ok: true, idempotent: false, snapshot: { id: input.snapshotId }, event: null, outbox: null },
      };
    },
  };
}
