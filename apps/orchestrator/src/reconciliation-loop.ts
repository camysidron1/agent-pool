import type {
  BackendInternalApiClient,
  ClaimNextCommandResponse,
  ClaimNextTaskResponse,
  ReconcileResponse,
} from "./backend-client";
import type { OrchestratorMetricsRecorder } from "./metrics";

export type ReconciliationBackend = Pick<
  BackendInternalApiClient,
  "reconcile" | "claimNextTask" | "claimNextCommand"
>;

export type ReconciliationClock = {
  readonly now: () => Date;
};

export type ReconciliationScheduler = {
  readonly setInterval: (callback: () => void | Promise<unknown>, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

export type ReconciliationOptions = {
  readonly projectId?: string;
  readonly backend: ReconciliationBackend;
  readonly clock?: ReconciliationClock;
  readonly staleAfterMs?: number;
  readonly lostAfterMs?: number;
  readonly runtimeProvider?: string;
  readonly metrics?: OrchestratorMetricsRecorder;
};

export type ReconciliationOnceResult = {
  readonly ok: boolean;
  readonly reconcileStatus: number;
  readonly staleCount: number;
  readonly lostCount: number;
  readonly taskClaimed: boolean;
  readonly taskNoWork: boolean;
  readonly commandClaimed: boolean;
  readonly commandNoWork: boolean;
};

export type ReconciliationLoopOptions = ReconciliationOptions & {
  readonly intervalMs: number;
  readonly scheduler?: ReconciliationScheduler;
};

export type ReconciliationLoop = {
  readonly running: boolean;
  readonly runOnce: () => Promise<ReconciliationOnceResult>;
  readonly start: () => void;
  readonly stop: () => void;
};

const DEFAULT_STALE_AFTER_MS = 5 * 60 * 1000;
const DEFAULT_LOST_AFTER_MS = 15 * 60 * 1000;

export async function runReconciliationOnce(options: ReconciliationOptions): Promise<ReconciliationOnceResult> {
  const now = options.clock?.now() ?? new Date();
  const staleAfterMs = readPositiveInteger(options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS, "staleAfterMs");
  const lostAfterMs = readPositiveInteger(options.lostAfterMs ?? DEFAULT_LOST_AFTER_MS, "lostAfterMs");
  const reconcile = await options.backend.reconcile({
    projectId: options.projectId,
    staleBefore: new Date(now.getTime() - staleAfterMs).toISOString(),
    lostBefore: new Date(now.getTime() - lostAfterMs).toISOString(),
    now: now.toISOString(),
  });

  if (!reconcile.ok || !isReconcileResponse(reconcile.body)) {
    const result = {
      ok: false,
      reconcileStatus: reconcile.status,
      staleCount: 0,
      lostCount: 0,
      taskClaimed: false,
      taskNoWork: false,
      commandClaimed: false,
      commandNoWork: false,
    };

    options.metrics?.recordReconciliationRun(result);
    return result;
  }

  const taskClaim = await options.backend.claimNextTask({
    projectId: options.projectId,
    runtimeProvider: options.runtimeProvider,
  });
  const commandClaim = await options.backend.claimNextCommand({ projectId: options.projectId });

  const result = {
    ok: taskClaim.ok && commandClaim.ok,
    reconcileStatus: reconcile.status,
    staleCount: reconcile.body.stale.length,
    lostCount: reconcile.body.lost.length,
    taskClaimed: isClaimNextTaskResponse(taskClaim.body) && taskClaim.body.claimed,
    taskNoWork: isClaimNextTaskResponse(taskClaim.body) && !taskClaim.body.claimed,
    commandClaimed: isClaimNextCommandResponse(commandClaim.body) && commandClaim.body.claimed,
    commandNoWork: isClaimNextCommandResponse(commandClaim.body) && !commandClaim.body.claimed,
  };

  options.metrics?.recordReconciliationRun(result);
  return result;
}

export function createReconciliationLoop(options: ReconciliationLoopOptions): ReconciliationLoop {
  const scheduler = options.scheduler ?? readGlobalScheduler();
  const intervalMs = readPositiveInteger(options.intervalMs, "intervalMs");
  let handle: unknown | null = null;
  let inFlight: Promise<unknown> | null = null;

  const runOnce = () => runReconciliationOnce(options);

  return {
    get running(): boolean {
      return handle !== null;
    },
    runOnce,
    start(): void {
      if (handle !== null) return;
      handle = scheduler.setInterval(() => {
        if (inFlight) return inFlight;
        inFlight = runOnce().finally(() => {
          inFlight = null;
        });
        return inFlight;
      }, intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      scheduler.clearInterval(handle);
      handle = null;
    },
  };
}

function isReconcileResponse(body: unknown): body is ReconcileResponse {
  if (!isRecord(body) || body.ok !== true) return false;

  return Array.isArray(body.stale) && Array.isArray(body.lost) && Array.isArray(body.events) && Array.isArray(body.outbox);
}

function isClaimNextTaskResponse(body: unknown): body is ClaimNextTaskResponse {
  return isRecord(body) && body.ok === true && typeof body.claimed === "boolean";
}

function isClaimNextCommandResponse(body: unknown): body is ClaimNextCommandResponse {
  return isRecord(body) && body.ok === true && typeof body.claimed === "boolean";
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null;
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function readGlobalScheduler(): ReconciliationScheduler {
  return {
    setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
