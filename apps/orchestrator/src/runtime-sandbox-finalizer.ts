import type { RuntimeProvider, RuntimeProviderKind, RuntimeSessionHandle, RuntimeSnapshotHandle } from "@agent-pool/runtime";

import type {
  BackendInternalApiClient,
  ClaimExpiredSnapshotDeletionResponse,
  ClaimRuntimeSandboxFinalizationResponse,
  ExpiredSnapshotDeletion,
  RuntimeSandboxFinalization,
} from "./backend-client";

export type RuntimeSandboxFinalizerBackend = Pick<
  BackendInternalApiClient,
  | "claimRuntimeSandboxFinalization"
  | "reportRuntimeSandboxSnapshotCreated"
  | "reportRuntimeSandboxSnapshotFailed"
  | "reportRuntimeSandboxCleanupSucceeded"
  | "reportRuntimeSandboxCleanupFailed"
  | "claimExpiredSnapshotDeletion"
  | "reportExpiredSnapshotDeleted"
  | "reportExpiredSnapshotDeleteFailed"
>;

export type RuntimeSandboxFinalizerClock = {
  readonly now: () => Date;
};

export type RuntimeSandboxFinalizerOptions = {
  readonly projectId?: string;
  readonly backend: RuntimeSandboxFinalizerBackend;
  readonly runtimeProvider: RuntimeProvider;
  readonly clock?: RuntimeSandboxFinalizerClock;
  readonly cleanupGraceMs?: number;
  readonly snapshotTtlMs?: number;
};

export type RuntimeSandboxFinalizerOnceResult = {
  readonly ok: boolean;
  readonly finalizationClaimed: boolean;
  readonly snapshotCreated: boolean;
  readonly snapshotFailed: boolean;
  readonly cleanupSucceeded: boolean;
  readonly cleanupFailed: boolean;
  readonly expiredSnapshotClaimed: boolean;
  readonly expiredSnapshotDeleted: boolean;
  readonly expiredSnapshotDeleteFailed: boolean;
  readonly noWork: boolean;
};

const DEFAULT_CLEANUP_GRACE_MS = 30_000;
const DEFAULT_SNAPSHOT_TTL_MS = 24 * 60 * 60 * 1000;

export async function runRuntimeSandboxFinalizerOnce(
  options: RuntimeSandboxFinalizerOptions,
): Promise<RuntimeSandboxFinalizerOnceResult> {
  const now = options.clock?.now() ?? new Date();
  const cleanupGraceMs = readNonNegativeInteger(options.cleanupGraceMs ?? DEFAULT_CLEANUP_GRACE_MS, "cleanupGraceMs");
  const snapshotTtlMs = readPositiveInteger(options.snapshotTtlMs ?? DEFAULT_SNAPSHOT_TTL_MS, "snapshotTtlMs");
  const finalizationClaim = await options.backend.claimRuntimeSandboxFinalization({
    projectId: options.projectId,
    cleanupGraceBefore: new Date(now.getTime() - cleanupGraceMs).toISOString(),
  });

  if (isClaimedFinalization(finalizationClaim.body)) {
    return finalizeRuntimeSandbox(options, finalizationClaim.body.finalization, now, snapshotTtlMs);
  }

  const deletionClaim = await options.backend.claimExpiredSnapshotDeletion({
    projectId: options.projectId,
    now: now.toISOString(),
  });
  if (isClaimedExpiredSnapshot(deletionClaim.body)) {
    return deleteExpiredSnapshot(options, deletionClaim.body.snapshot);
  }

  return emptyResult({ noWork: true });
}

async function finalizeRuntimeSandbox(
  options: RuntimeSandboxFinalizerOptions,
  finalization: RuntimeSandboxFinalization,
  now: Date,
  snapshotTtlMs: number,
): Promise<RuntimeSandboxFinalizerOnceResult> {
  const handle = finalizationHandle(finalization);
  let snapshotCreated = false;
  let snapshotFailed = false;

  if (finalization.snapshotRequired) {
    try {
      const snapshot = await options.runtimeProvider.createSnapshot(handle);
      const reported = await options.backend.reportRuntimeSandboxSnapshotCreated({
        projectId: finalization.projectId,
        runtimeSandboxId: finalization.id,
        providerSnapshotId: snapshot.snapshotId,
        expiresAt: new Date(now.getTime() + snapshotTtlMs).toISOString(),
        metadata: snapshot.metadata,
      });
      snapshotCreated = reported.ok;
      snapshotFailed = !reported.ok;
    } catch (error) {
      snapshotFailed = true;
      await options.backend.reportRuntimeSandboxSnapshotFailed({
        projectId: finalization.projectId,
        runtimeSandboxId: finalization.id,
        errorMessage: errorMessage(error),
      });
    }
  }

  try {
    await options.runtimeProvider.stopSession(handle);
    const reported = await options.backend.reportRuntimeSandboxCleanupSucceeded({
      projectId: finalization.projectId,
      runtimeSandboxId: finalization.id,
    });
    return {
      ...emptyResult(),
      ok: reported.ok && !snapshotFailed,
      finalizationClaimed: true,
      snapshotCreated,
      snapshotFailed,
      cleanupSucceeded: reported.ok,
      cleanupFailed: !reported.ok,
    };
  } catch (error) {
    await options.backend.reportRuntimeSandboxCleanupFailed({
      projectId: finalization.projectId,
      runtimeSandboxId: finalization.id,
      errorMessage: errorMessage(error),
    });
    return {
      ...emptyResult(),
      ok: false,
      finalizationClaimed: true,
      snapshotCreated,
      snapshotFailed,
      cleanupFailed: true,
    };
  }
}

async function deleteExpiredSnapshot(
  options: RuntimeSandboxFinalizerOptions,
  snapshot: ExpiredSnapshotDeletion,
): Promise<RuntimeSandboxFinalizerOnceResult> {
  try {
    await options.runtimeProvider.deleteSnapshot(snapshotHandle(snapshot));
    const reported = await options.backend.reportExpiredSnapshotDeleted({
      projectId: snapshot.projectId,
      snapshotId: snapshot.id,
    });
    return {
      ...emptyResult(),
      ok: reported.ok,
      expiredSnapshotClaimed: true,
      expiredSnapshotDeleted: reported.ok,
      expiredSnapshotDeleteFailed: !reported.ok,
    };
  } catch (error) {
    await options.backend.reportExpiredSnapshotDeleteFailed({
      projectId: snapshot.projectId,
      snapshotId: snapshot.id,
      errorMessage: errorMessage(error),
    });
    return {
      ...emptyResult(),
      ok: false,
      expiredSnapshotClaimed: true,
      expiredSnapshotDeleteFailed: true,
    };
  }
}

function finalizationHandle(finalization: RuntimeSandboxFinalization): RuntimeSessionHandle {
  return {
    provider: readRuntimeProviderKind(finalization.provider),
    sessionId: finalization.providerSandboxId,
    projectId: finalization.projectId,
    taskId: finalization.taskId,
    metadata: {
      agentPoolSessionId: finalization.sessionId,
      sandboxId: finalization.providerSandboxId,
      runtimeSandboxId: finalization.id,
      sourceSnapshotId: finalization.sourceSnapshotId,
    },
  };
}

function snapshotHandle(snapshot: ExpiredSnapshotDeletion): RuntimeSnapshotHandle {
  return {
    provider: readRuntimeProviderKind(snapshot.provider),
    snapshotId: snapshot.providerSnapshotId,
    metadata: {
      snapshotRecordId: snapshot.id,
    },
  };
}

function readRuntimeProviderKind(value: string): RuntimeProviderKind {
  if (value === "fake" || value === "e2b" || value === "docker") return value;
  throw new Error(`unsupported runtime provider: ${value}`);
}

function isClaimedFinalization(body: unknown): body is Extract<ClaimRuntimeSandboxFinalizationResponse, { readonly claimed: true }> {
  return isRecord(body) && body.ok === true && body.claimed === true && isRecord(body.finalization);
}

function isClaimedExpiredSnapshot(body: unknown): body is Extract<ClaimExpiredSnapshotDeletionResponse, { readonly claimed: true }> {
  return isRecord(body) && body.ok === true && body.claimed === true && isRecord(body.snapshot);
}

function emptyResult(overrides: Partial<RuntimeSandboxFinalizerOnceResult> = {}): RuntimeSandboxFinalizerOnceResult {
  return {
    ok: true,
    finalizationClaimed: false,
    snapshotCreated: false,
    snapshotFailed: false,
    cleanupSucceeded: false,
    cleanupFailed: false,
    expiredSnapshotClaimed: false,
    expiredSnapshotDeleted: false,
    expiredSnapshotDeleteFailed: false,
    noWork: false,
    ...overrides,
  };
}

function readNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
