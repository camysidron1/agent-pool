import type {
  BridgeCallbackClient,
  BridgeCallbackEvent,
  BridgeClock,
  BridgeEventBufferRecord,
} from "./index";

export type BridgeEventDeadLetterRecord = BridgeEventBufferRecord & {
  readonly deadLetteredAt: string;
};

export type BridgeEventBufferOptions = {
  readonly maxAttempts?: number;
  readonly clock?: BridgeClock;
  readonly idFactory?: () => string;
};

export type BridgeEventBufferFlushResult = {
  readonly attempted: number;
  readonly delivered: number;
  readonly retained: number;
  readonly deadLettered: number;
};

export type BridgeEventBuffer = {
  readonly pending: readonly BridgeEventBufferRecord[];
  readonly deadLetters: readonly BridgeEventDeadLetterRecord[];
  readonly enqueue: (event: BridgeCallbackEvent, lastError?: string) => BridgeEventBufferRecord;
  readonly flush: (client: Pick<BridgeCallbackClient, "postEvent">) => Promise<BridgeEventBufferFlushResult>;
};

export function createBridgeEventBuffer(options: BridgeEventBufferOptions = {}): BridgeEventBuffer {
  const maxAttempts = readPositiveInteger(options.maxAttempts ?? 3, "maxAttempts");
  const clock = options.clock ?? { now: () => new Date() };
  const idFactory = options.idFactory ?? sequentialIdFactory();
  let pending: BridgeEventBufferRecord[] = [];
  let deadLetters: BridgeEventDeadLetterRecord[] = [];

  return {
    get pending(): readonly BridgeEventBufferRecord[] {
      return [...pending];
    },
    get deadLetters(): readonly BridgeEventDeadLetterRecord[] {
      return [...deadLetters];
    },
    enqueue(event, lastError): BridgeEventBufferRecord {
      const record = {
        id: idFactory(),
        event,
        attempts: 0,
        lastError,
      };

      pending = [...pending, record];
      return record;
    },
    async flush(client): Promise<BridgeEventBufferFlushResult> {
      const snapshot = pending;
      let delivered = 0;
      let retained = 0;
      let deadLettered = 0;
      const nextPending: BridgeEventBufferRecord[] = [];

      for (const record of snapshot) {
        const result = await client.postEvent(record.event);

        if (result.ok) {
          delivered += 1;
          continue;
        }

        const failed = {
          ...record,
          attempts: record.attempts + 1,
          lastError: result.errorMessage,
        };

        if (failed.attempts >= maxAttempts) {
          deadLettered += 1;
          deadLetters = [
            ...deadLetters,
            {
              ...failed,
              deadLetteredAt: clock.now().toISOString(),
            },
          ];
        } else {
          retained += 1;
          nextPending.push(failed);
        }
      }

      pending = nextPending;

      return {
        attempted: snapshot.length,
        delivered,
        retained,
        deadLettered,
      };
    },
  };
}

function sequentialIdFactory(): () => string {
  let sequence = 0;
  return () => {
    sequence += 1;
    return `bridge_event_${sequence}`;
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}
