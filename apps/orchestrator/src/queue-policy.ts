import type { QueueConsumerMessage, QueueConsumerResult } from "@agent-pool/queue";

export type QueueDecisionPolicyOptions = {
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
};

export type QueueDecisionPolicy = {
  readonly maxAttempts: number;
  readonly retryDelayMs: number;
  readonly ack: () => QueueConsumerResult;
  readonly retry: (
    message: QueueConsumerMessage<unknown>,
    reason: string,
    delayMs?: number,
  ) => QueueConsumerResult;
  readonly deadLetter: (reason: string) => QueueConsumerResult;
};

export function createQueueDecisionPolicy(options: QueueDecisionPolicyOptions = {}): QueueDecisionPolicy {
  const maxAttempts = readPositiveInteger(options.maxAttempts ?? 3, "maxAttempts");
  const retryDelayMs = readNonNegativeInteger(options.retryDelayMs ?? 1000, "retryDelayMs");

  return {
    maxAttempts,
    retryDelayMs,
    ack: () => ({ action: "ack" }),
    retry: (message, reason, delayMs = retryDelayMs) => {
      if (message.attempts >= maxAttempts) {
        return {
          action: "dead-letter",
          reason: `max_attempts_exhausted:${reason}`,
        };
      }

      return {
        action: "retry",
        reason,
        delayMs,
      };
    },
    deadLetter: (reason) => ({
      action: "dead-letter",
      reason,
    }),
  };
}

function readPositiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }

  return value;
}

function readNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}
