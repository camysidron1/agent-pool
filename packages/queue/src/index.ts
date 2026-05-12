import type { RabbitMqConfig } from "@agent-pool/config";

export type ProjectQueueKind = "task" | "control";

export type ProjectQueueNames = {
  readonly taskQueue: string;
  readonly controlQueue: string;
};

export type ProjectQueueDeclaration = {
  readonly projectId: string;
  readonly kind: ProjectQueueKind;
  readonly queue: string;
  readonly durable: true;
};

export type QueueEnvelope<TPayload> = {
  readonly id: string;
  readonly queue: string;
  readonly kind: ProjectQueueKind | "raw";
  readonly payload: TPayload;
  readonly enqueuedAt: string;
};

export type QueueConsumerMessage<TPayload> = QueueEnvelope<TPayload> & {
  readonly attempts: number;
  readonly lastRetryReason?: string;
  readonly availableAt?: string;
  readonly deadLetterReason?: string;
  readonly deadLetteredAt?: string;
};

export type QueueConsumerResult =
  | { readonly action: "ack" }
  | { readonly action: "retry"; readonly reason: string; readonly delayMs?: number }
  | { readonly action: "dead-letter"; readonly reason: string };

export type QueueConsumer<TPayload> = (
  message: QueueConsumerMessage<TPayload>,
) => QueueConsumerResult | Promise<QueueConsumerResult>;

export type QueueDrainResult = {
  readonly queue: string;
  readonly processed: number;
  readonly acked: number;
  readonly retried: number;
  readonly deadLettered: number;
};

export type RabbitMqAdapter = {
  readonly kind: "rabbitmq";
  readonly url: string;
  readonly connected: false;
  readonly declaredQueues: readonly ProjectQueueDeclaration[];
  readonly publishedHints: readonly QueueEnvelope<unknown>[];
  readonly pendingMessages: readonly QueueConsumerMessage<unknown>[];
  readonly deadLetters: readonly QueueConsumerMessage<unknown>[];
  readonly projectQueues: (projectId: string) => ProjectQueueNames;
  readonly declareProjectQueues: (projectId: string) => readonly ProjectQueueDeclaration[];
  readonly publishProjectTaskHint: <TPayload>(projectId: string, payload: TPayload) => QueueEnvelope<TPayload>;
  readonly publishProjectControlHint: <TPayload>(projectId: string, payload: TPayload) => QueueEnvelope<TPayload>;
  readonly publishHint: <TPayload>(
    queue: string,
    kind: ProjectQueueKind | "raw",
    payload: TPayload,
  ) => QueueEnvelope<TPayload>;
  readonly enqueueHint: <TPayload>(queue: string, payload: TPayload) => QueueEnvelope<TPayload>;
  readonly drainQueue: <TPayload>(queue: string, consumer: QueueConsumer<TPayload>) => Promise<QueueDrainResult>;
};

export const QUEUE_PACKAGE_BOUNDARY = {
  durableWakeups: "rabbitmq",
  messagesAreHints: true,
  perSessionQueuesForMvp: false,
} as const;

export function createProjectQueueNames(config: RabbitMqConfig, projectId: string): ProjectQueueNames {
  const safeProjectId = sanitizeProjectId(projectId);

  return {
    taskQueue: `${config.projectTaskQueuePrefix}.${safeProjectId}`,
    controlQueue: `${config.projectControlQueuePrefix}.${safeProjectId}`,
  };
}

export function createProjectQueueDeclarations(config: RabbitMqConfig, projectId: string): readonly ProjectQueueDeclaration[] {
  const queues = createProjectQueueNames(config, projectId);

  return [
    {
      projectId,
      kind: "task",
      queue: queues.taskQueue,
      durable: true,
    },
    {
      projectId,
      kind: "control",
      queue: queues.controlQueue,
      durable: true,
    },
  ];
}

export function createRabbitMqAdapter(config: RabbitMqConfig): RabbitMqAdapter {
  const state: {
    declarations: ProjectQueueDeclaration[];
    published: QueueConsumerMessage<unknown>[];
    deadLetters: QueueConsumerMessage<unknown>[];
    sequence: number;
  } = {
    declarations: [],
    published: [],
    deadLetters: [],
    sequence: 0,
  };

  return {
    kind: "rabbitmq",
    url: config.url,
    connected: false,
    get declaredQueues(): readonly ProjectQueueDeclaration[] {
      return [...state.declarations];
    },
    get publishedHints(): readonly QueueEnvelope<unknown>[] {
      return state.published.map(stripConsumerMetadata);
    },
    get pendingMessages(): readonly QueueConsumerMessage<unknown>[] {
      return [...state.published];
    },
    get deadLetters(): readonly QueueConsumerMessage<unknown>[] {
      return [...state.deadLetters];
    },
    projectQueues(projectId: string): ProjectQueueNames {
      return createProjectQueueNames(config, projectId);
    },
    declareProjectQueues(projectId: string): readonly ProjectQueueDeclaration[] {
      const declarations = createProjectQueueDeclarations(config, projectId);
      for (const declaration of declarations) {
        if (!state.declarations.some((existing) => existing.queue === declaration.queue)) {
          state.declarations.push(declaration);
        }
      }
      return declarations;
    },
    publishProjectTaskHint<TPayload>(projectId: string, payload: TPayload): QueueEnvelope<TPayload> {
      const queue = createProjectQueueNames(config, projectId).taskQueue;
      return publish(state, queue, "task", payload);
    },
    publishProjectControlHint<TPayload>(projectId: string, payload: TPayload): QueueEnvelope<TPayload> {
      const queue = createProjectQueueNames(config, projectId).controlQueue;
      return publish(state, queue, "control", payload);
    },
    publishHint<TPayload>(queue: string, kind: ProjectQueueKind | "raw", payload: TPayload): QueueEnvelope<TPayload> {
      return publish(state, queue, kind, payload);
    },
    enqueueHint<TPayload>(queue: string, payload: TPayload): QueueEnvelope<TPayload> {
      return publish(state, queue, "raw", payload);
    },
    async drainQueue<TPayload>(queue: string, consumer: QueueConsumer<TPayload>): Promise<QueueDrainResult> {
      const pending = state.published.filter((message) => message.queue === queue);
      let acked = 0;
      let retried = 0;
      let deadLettered = 0;

      for (const message of pending) {
        state.published = state.published.filter((candidate) => candidate.id !== message.id);
        const consumerMessage = { ...message } as QueueConsumerMessage<TPayload>;
        const result = await consumer(consumerMessage);

        switch (result.action) {
          case "ack":
            acked += 1;
            break;
          case "retry":
            retried += 1;
            state.published.push({
              ...message,
              id: nextQueueMessageId(state),
              enqueuedAt: deterministicTimestamp(),
              attempts: message.attempts + 1,
              lastRetryReason: result.reason,
              availableAt: deterministicTimestamp(result.delayMs ?? 0),
            });
            break;
          case "dead-letter":
            deadLettered += 1;
            state.deadLetters.push({
              ...consumerMessage,
              deadLetterReason: result.reason,
              deadLetteredAt: deterministicTimestamp(),
            } as QueueConsumerMessage<unknown>);
            break;
        }
      }

      return {
        queue,
        processed: pending.length,
        acked,
        retried,
        deadLettered,
      };
    },
  };
}

function publish<TPayload>(
  state: { sequence: number; published: QueueConsumerMessage<unknown>[] },
  queue: string,
  kind: ProjectQueueKind | "raw",
  payload: TPayload,
): QueueEnvelope<TPayload> {
  const envelope = {
    id: nextQueueMessageId(state),
    queue,
    kind,
    payload,
    enqueuedAt: deterministicTimestamp(),
  };

  state.published.push({ ...envelope, attempts: 1 });
  return envelope;
}

function stripConsumerMetadata(message: QueueConsumerMessage<unknown>): QueueEnvelope<unknown> {
  return {
    id: message.id,
    queue: message.queue,
    kind: message.kind,
    payload: message.payload,
    enqueuedAt: message.enqueuedAt,
  };
}

function nextQueueMessageId(state: { sequence: number }): string {
  state.sequence += 1;
  return `queue_message_${state.sequence}`;
}

function deterministicTimestamp(offsetMs = 0): string {
  return new Date(offsetMs).toISOString();
}

function sanitizeProjectId(projectId: string): string {
  const value = projectId.trim().replace(/[^a-zA-Z0-9_-]/g, "-");

  if (!value) {
    throw new Error("projectId is required for project queue names");
  }

  return value;
}
