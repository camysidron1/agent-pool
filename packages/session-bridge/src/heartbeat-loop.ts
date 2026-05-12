import type {
  BridgeCallbackClient,
  BridgeCallbackResult,
  BridgeClock,
  BridgeHeartbeatPayload,
  BridgeScheduler,
  BridgeSessionOptions,
} from "./index";

export type BridgeHeartbeatFailure = {
  readonly event: BridgeHeartbeatPayload;
  readonly result: BridgeCallbackResult;
};

export type BridgeHeartbeatLoopOptions = {
  readonly session: BridgeSessionOptions;
  readonly client: Pick<BridgeCallbackClient, "postEvent">;
  readonly intervalMs: number;
  readonly clock?: BridgeClock;
  readonly scheduler?: BridgeScheduler;
  readonly onFailure?: (failure: BridgeHeartbeatFailure) => void | Promise<void>;
};

export type BridgeHeartbeatLoop = {
  readonly running: boolean;
  readonly tick: () => Promise<BridgeCallbackResult>;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createBridgeHeartbeatLoop(options: BridgeHeartbeatLoopOptions): BridgeHeartbeatLoop {
  const intervalMs = readPositiveInteger(options.intervalMs, "intervalMs");
  const scheduler = options.scheduler ?? globalScheduler();
  let handle: unknown | null = null;
  let inFlight: Promise<unknown> | null = null;

  const tick = async (): Promise<BridgeCallbackResult> => {
    const event = heartbeatPayload(options.session, options.clock?.now() ?? new Date());
    const result = await options.client.postEvent(event);

    if (!result.ok) {
      await options.onFailure?.({ event, result });
    }

    return result;
  };

  return {
    get running(): boolean {
      return handle !== null;
    },
    tick,
    start(): void {
      if (handle !== null) return;
      handle = scheduler.setInterval(() => {
        if (inFlight) return inFlight;
        inFlight = tick().finally(() => {
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

function heartbeatPayload(session: BridgeSessionOptions, observedAt: Date): BridgeHeartbeatPayload {
  return {
    kind: "heartbeat",
    projectId: session.projectId,
    taskId: session.taskId,
    sessionId: session.sessionId,
    observedAt: observedAt.toISOString(),
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function globalScheduler(): BridgeScheduler {
  return {
    setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
