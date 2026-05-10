import { DEFAULT_PROJECT_TASK_QUEUE } from "@agent-pool/shared";

export type QueueName = typeof DEFAULT_PROJECT_TASK_QUEUE | "project-controls";

export type QueueEnvelope<TPayload> = {
  readonly queue: QueueName;
  readonly payload: TPayload;
  readonly enqueuedAt: string;
};

export const QUEUE_PACKAGE_BOUNDARY = {
  durableWakeups: "rabbitmq",
  messagesAreHints: true,
  perSessionQueuesForMvp: false,
} as const;
