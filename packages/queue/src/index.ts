import type { RabbitMqConfig } from "@agent-pool/config";

export type ProjectQueueKind = "tasks" | "control";

export type ProjectQueueNames = {
  readonly taskQueue: string;
  readonly controlQueue: string;
};

export type QueueEnvelope<TPayload> = {
  readonly queue: string;
  readonly payload: TPayload;
  readonly enqueuedAt: string;
};

export type RabbitMqAdapter = {
  readonly kind: "rabbitmq";
  readonly url: string;
  readonly connected: false;
  readonly projectQueues: (projectId: string) => ProjectQueueNames;
  readonly enqueueHint: <TPayload>(queue: string, payload: TPayload) => QueueEnvelope<TPayload>;
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

export function createRabbitMqAdapter(config: RabbitMqConfig): RabbitMqAdapter {
  return {
    kind: "rabbitmq",
    url: config.url,
    connected: false,
    projectQueues(projectId: string): ProjectQueueNames {
      return createProjectQueueNames(config, projectId);
    },
    enqueueHint<TPayload>(queue: string, payload: TPayload): QueueEnvelope<TPayload> {
      return {
        queue,
        payload,
        enqueuedAt: new Date(0).toISOString(),
      };
    },
  };
}

function sanitizeProjectId(projectId: string): string {
  const value = projectId.trim().replace(/[^a-zA-Z0-9_-]/g, "-");

  if (!value) {
    throw new Error("projectId is required for project queue names");
  }

  return value;
}
