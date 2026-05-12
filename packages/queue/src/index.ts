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
  readonly connected: boolean;
  readonly transport: "memory" | "management-http";
  readonly declaredQueues: readonly ProjectQueueDeclaration[];
  readonly publishedHints: readonly QueueEnvelope<unknown>[];
  readonly pendingMessages: readonly QueueConsumerMessage<unknown>[];
  readonly deadLetters: readonly QueueConsumerMessage<unknown>[];
  readonly flush?: () => Promise<void>;
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
    transport: "memory",
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

export type RabbitMqManagementHttpAdapterOptions = {
  readonly fetch?: typeof fetch;
  readonly maxMessagesPerDrain?: number;
};

type RabbitMqManagementGetMessage = {
  readonly payload?: unknown;
  readonly payload_bytes?: number;
  readonly redelivered?: boolean;
};

export function createRabbitMqManagementHttpAdapter(
  config: RabbitMqConfig,
  options: RabbitMqManagementHttpAdapterOptions = {},
): RabbitMqAdapter {
  const state: {
    declarations: ProjectQueueDeclaration[];
    published: QueueConsumerMessage<unknown>[];
    deadLetters: QueueConsumerMessage<unknown>[];
    pendingOperations: Promise<unknown>[];
    sequence: number;
  } = {
    declarations: [],
    published: [],
    deadLetters: [],
    pendingOperations: [],
    sequence: 0,
  };
  const fetchImpl = options.fetch ?? fetch;
  const management = parseManagementUrl(config.managementUrl);

  const enqueueOperation = (operation: Promise<unknown>): void => {
    state.pendingOperations.push(operation);
    operation.finally(() => {
      state.pendingOperations = state.pendingOperations.filter((candidate) => candidate !== operation);
    });
  };

  const flush = async (): Promise<void> => {
    while (state.pendingOperations.length > 0) {
      await Promise.all(state.pendingOperations);
    }
  };

  return {
    kind: "rabbitmq",
    url: config.url,
    connected: true,
    transport: "management-http",
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
    flush,
    projectQueues(projectId: string): ProjectQueueNames {
      return createProjectQueueNames(config, projectId);
    },
    declareProjectQueues(projectId: string): readonly ProjectQueueDeclaration[] {
      const declarations = createProjectQueueDeclarations(config, projectId);
      for (const declaration of declarations) {
        if (!state.declarations.some((existing) => existing.queue === declaration.queue)) {
          state.declarations.push(declaration);
          enqueueOperation(declareQueue(fetchImpl, management, declaration.queue));
        }
      }
      return declarations;
    },
    publishProjectTaskHint<TPayload>(projectId: string, payload: TPayload): QueueEnvelope<TPayload> {
      const queue = createProjectQueueNames(config, projectId).taskQueue;
      return publishLive(state, fetchImpl, management, queue, "task", payload, enqueueOperation);
    },
    publishProjectControlHint<TPayload>(projectId: string, payload: TPayload): QueueEnvelope<TPayload> {
      const queue = createProjectQueueNames(config, projectId).controlQueue;
      return publishLive(state, fetchImpl, management, queue, "control", payload, enqueueOperation);
    },
    publishHint<TPayload>(queue: string, kind: ProjectQueueKind | "raw", payload: TPayload): QueueEnvelope<TPayload> {
      return publishLive(state, fetchImpl, management, queue, kind, payload, enqueueOperation);
    },
    enqueueHint<TPayload>(queue: string, payload: TPayload): QueueEnvelope<TPayload> {
      return publishLive(state, fetchImpl, management, queue, "raw", payload, enqueueOperation);
    },
    async drainQueue<TPayload>(queue: string, consumer: QueueConsumer<TPayload>): Promise<QueueDrainResult> {
      await flush();
      const messages = await getMessages(fetchImpl, management, queue, options.maxMessagesPerDrain ?? 50);
      let acked = 0;
      let retried = 0;
      let deadLettered = 0;

      for (const message of messages) {
        const envelope = decodeEnvelope<TPayload>(message, queue);
        state.published = state.published.filter((candidate) => candidate.id !== envelope.id);
        const result = await consumer(envelope);

        switch (result.action) {
          case "ack":
            acked += 1;
            break;
          case "retry": {
            retried += 1;
            const retry = {
              ...envelope,
              id: nextQueueMessageId(state),
              enqueuedAt: deterministicTimestamp(result.delayMs ?? 0),
              attempts: envelope.attempts + 1,
              lastRetryReason: result.reason,
              availableAt: deterministicTimestamp(result.delayMs ?? 0),
            };
            state.published.push(retry);
            await publishEnvelope(fetchImpl, management, queue, stripConsumerMetadata(retry));
            break;
          }
          case "dead-letter":
            deadLettered += 1;
            state.deadLetters.push({
              ...envelope,
              deadLetterReason: result.reason,
              deadLetteredAt: deterministicTimestamp(),
            } as QueueConsumerMessage<unknown>);
            break;
        }
      }

      return {
        queue,
        processed: messages.length,
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

function publishLive<TPayload>(
  state: {
    sequence: number;
    published: QueueConsumerMessage<unknown>[];
  },
  fetchImpl: typeof fetch,
  management: RabbitMqManagementEndpoint,
  queue: string,
  kind: ProjectQueueKind | "raw",
  payload: TPayload,
  enqueueOperation: (operation: Promise<unknown>) => void,
): QueueEnvelope<TPayload> {
  const envelope = {
    id: nextQueueMessageId(state),
    queue,
    kind,
    payload,
    enqueuedAt: deterministicTimestamp(),
  };

  state.published.push({ ...envelope, attempts: 1 });
  enqueueOperation(publishEnvelope(fetchImpl, management, queue, envelope));
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

type RabbitMqManagementEndpoint = {
  readonly baseUrl: string;
  readonly authorization?: string;
};

function parseManagementUrl(value: string): RabbitMqManagementEndpoint {
  const url = new URL(value);
  const authorization = url.username || url.password ? `Basic ${btoa(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`)}` : undefined;
  url.username = "";
  url.password = "";

  return {
    baseUrl: url.toString().replace(/\/$/, ""),
    authorization,
  };
}

async function declareQueue(
  fetchImpl: typeof fetch,
  management: RabbitMqManagementEndpoint,
  queue: string,
): Promise<void> {
  const response = await fetchImpl(`${management.baseUrl}/api/queues/%2F/${encodeURIComponent(queue)}`, {
    method: "PUT",
    headers: managementHeaders(management),
    body: JSON.stringify({
      durable: true,
      auto_delete: false,
      arguments: {},
    }),
  });

  await assertRabbitMqResponse(response, `declare queue ${queue}`);
}

async function publishEnvelope<TPayload>(
  fetchImpl: typeof fetch,
  management: RabbitMqManagementEndpoint,
  queue: string,
  envelope: QueueEnvelope<TPayload>,
): Promise<void> {
  const response = await fetchImpl(`${management.baseUrl}/api/exchanges/%2F/amq.default/publish`, {
    method: "POST",
    headers: managementHeaders(management),
    body: JSON.stringify({
      properties: {
        delivery_mode: 2,
        content_type: "application/json",
      },
      routing_key: queue,
      payload: JSON.stringify(envelope),
      payload_encoding: "string",
    }),
  });

  await assertRabbitMqResponse(response, `publish queue ${queue}`);
}

async function getMessages(
  fetchImpl: typeof fetch,
  management: RabbitMqManagementEndpoint,
  queue: string,
  count: number,
): Promise<readonly RabbitMqManagementGetMessage[]> {
  const response = await fetchImpl(`${management.baseUrl}/api/queues/%2F/${encodeURIComponent(queue)}/get`, {
    method: "POST",
    headers: managementHeaders(management),
    body: JSON.stringify({
      count,
      ackmode: "ack_requeue_false",
      encoding: "auto",
      truncate: 50000,
    }),
  });

  await assertRabbitMqResponse(response, `get queue ${queue}`);
  const body = await response.json().catch(() => []);

  return Array.isArray(body) ? body.filter(isRabbitMqMessage) : [];
}

function decodeEnvelope<TPayload>(
  message: RabbitMqManagementGetMessage,
  queue: string,
): QueueConsumerMessage<TPayload> {
  const raw = typeof message.payload === "string" ? JSON.parse(message.payload) : message.payload;
  const payload = isQueueEnvelope<TPayload>(raw)
    ? raw
    : {
        id: "rabbitmq_message",
        queue,
        kind: "raw" as const,
        payload: raw as TPayload,
        enqueuedAt: deterministicTimestamp(),
      };

  return {
    ...payload,
    queue,
    attempts: 1,
  };
}

function isQueueEnvelope<TPayload>(value: unknown): value is QueueEnvelope<TPayload> {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly id?: unknown; readonly queue?: unknown; readonly kind?: unknown; readonly enqueuedAt?: unknown };

  return (
    typeof candidate.id === "string" &&
    typeof candidate.queue === "string" &&
    typeof candidate.kind === "string" &&
    typeof candidate.enqueuedAt === "string" &&
    "payload" in value
  );
}

function isRabbitMqMessage(value: unknown): value is RabbitMqManagementGetMessage {
  return Boolean(value && typeof value === "object" && "payload" in value);
}

function managementHeaders(management: RabbitMqManagementEndpoint): Headers {
  const headers = new Headers({ "content-type": "application/json" });
  if (management.authorization) {
    headers.set("authorization", management.authorization);
  }
  return headers;
}

async function assertRabbitMqResponse(response: Response, action: string): Promise<void> {
  if (response.status >= 200 && response.status < 300) return;
  const body = await response.text().catch(() => "");

  throw new Error(`${action} failed with status ${response.status}${body ? `: ${body}` : ""}`);
}
