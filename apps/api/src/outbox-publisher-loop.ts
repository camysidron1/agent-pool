import type {
  OutboxPublisher,
  PublishQueuedOutboxOptions,
  PublishQueuedOutboxResult,
} from "./outbox-publisher";

export type OutboxPublisherLoopScheduler = {
  readonly setInterval: (callback: () => void | Promise<void>, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

export type OutboxPublisherLoopOptions = {
  readonly publisher: Pick<OutboxPublisher, "publishQueuedAsync">;
  readonly intervalMs: number;
  readonly publishOptions?: PublishQueuedOutboxOptions;
  readonly scheduler?: OutboxPublisherLoopScheduler;
  readonly onError?: (error: unknown) => void;
};

export type OutboxPublisherLoopState = {
  readonly running: boolean;
  readonly ticks: number;
  readonly failures: number;
  readonly inFlight: boolean;
  readonly lastResult: PublishQueuedOutboxResult | null;
  readonly lastError: string | null;
};

export type OutboxPublisherLoop = {
  readonly state: OutboxPublisherLoopState;
  readonly tick: () => Promise<PublishQueuedOutboxResult | null>;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createOutboxPublisherLoop(options: OutboxPublisherLoopOptions): OutboxPublisherLoop {
  const intervalMs = readPositiveInteger(options.intervalMs, "intervalMs");
  const scheduler = options.scheduler ?? globalScheduler();
  let handle: unknown | null = null;
  let inFlight: Promise<PublishQueuedOutboxResult | null> | null = null;
  let ticks = 0;
  let failures = 0;
  let lastResult: PublishQueuedOutboxResult | null = null;
  let lastError: string | null = null;

  const tick = async (): Promise<PublishQueuedOutboxResult | null> => {
    if (inFlight) return inFlight;

    inFlight = options.publisher
      .publishQueuedAsync(options.publishOptions)
      .then((result) => {
        ticks += 1;
        lastResult = result;
        lastError = null;
        return result;
      })
      .catch((error: unknown) => {
        ticks += 1;
        failures += 1;
        lastError = error instanceof Error ? error.message : String(error);
        options.onError?.(error);
        return null;
      })
      .finally(() => {
        inFlight = null;
      });

    return inFlight;
  };

  return {
    get state(): OutboxPublisherLoopState {
      return {
        running: handle !== null,
        ticks,
        failures,
        inFlight: inFlight !== null,
        lastResult,
        lastError,
      };
    },
    tick,
    start(): void {
      if (handle !== null) return;
      handle = scheduler.setInterval(() => {
        void tick();
      }, intervalMs);
    },
    stop(): void {
      if (handle === null) return;
      scheduler.clearInterval(handle);
      handle = null;
    },
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function globalScheduler(): OutboxPublisherLoopScheduler {
  return {
    setInterval: (callback, intervalMs) => globalThis.setInterval(callback, intervalMs),
    clearInterval: (handle) => globalThis.clearInterval(handle as ReturnType<typeof setInterval>),
  };
}
