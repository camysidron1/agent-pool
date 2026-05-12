import type { RabbitMqAdapter } from "@agent-pool/queue";

import type { ApiDatabaseConnection } from "./database";

export type OutboxPublisherOptions = {
  readonly database: ApiDatabaseConnection;
  readonly queue: RabbitMqAdapter;
};

export type PublishQueuedOutboxOptions = {
  readonly limit?: number;
};

export type PublishedOutboxRecord = {
  readonly outboxId: string;
  readonly projectId: string;
  readonly queue: string;
  readonly queueKind: "task" | "control";
};

export type FailedOutboxRecord = {
  readonly outboxId: string;
  readonly projectId: string;
  readonly error: string;
};

export type PublishQueuedOutboxResult = {
  readonly scanned: number;
  readonly published: readonly PublishedOutboxRecord[];
  readonly failed: readonly FailedOutboxRecord[];
};

export type OutboxPublisher = ReturnType<typeof createOutboxPublisher>;

type QueuedOutboxRow = {
  readonly id: string;
  readonly project_id: string;
  readonly event_id: string | null;
  readonly routing_key: string;
  readonly payload_json: string;
  readonly event_type: string | null;
};

export function createOutboxPublisher(options: OutboxPublisherOptions) {
  return {
    publishQueued(input: PublishQueuedOutboxOptions = {}): PublishQueuedOutboxResult {
      const rows = selectQueuedOutboxRows(options.database, input.limit ?? 50);
      const published: PublishedOutboxRecord[] = [];
      const failed: FailedOutboxRecord[] = [];

      for (const row of rows) {
        const queueKind = resolveQueueKind(row);
        try {
          const envelope =
            queueKind === "task"
              ? options.queue.publishProjectTaskHint(row.project_id, outboxPayload(row))
              : options.queue.publishProjectControlHint(row.project_id, outboxPayload(row));

          markOutboxPublished(options.database, row.id);
          published.push({
            outboxId: row.id,
            projectId: row.project_id,
            queue: envelope.queue,
            queueKind,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markOutboxFailed(options.database, row.id, message);
          failed.push({ outboxId: row.id, projectId: row.project_id, error: message });
        }
      }

      return { scanned: rows.length, published, failed };
    },
  };
}

function selectQueuedOutboxRows(database: ApiDatabaseConnection, limit: number): QueuedOutboxRow[] {
  return database.sqlite
    .query<QueuedOutboxRow, [number]>(
      `
        SELECT
          o.id,
          o.project_id,
          o.event_id,
          o.routing_key,
          o.payload_json,
          e.type AS event_type
        FROM outbox o
        LEFT JOIN events e ON e.project_id = o.project_id AND e.id = o.event_id
        WHERE o.status = 'queued'
        ORDER BY o.created_at ASC, o.rowid ASC
        LIMIT ?
      `,
    )
    .all(limit);
}

function resolveQueueKind(row: QueuedOutboxRow): "task" | "control" {
  if (row.routing_key.endsWith(".control")) return "control";
  if (row.event_type?.startsWith("command.") || row.event_type?.startsWith("session.")) return "control";
  return "task";
}

function outboxPayload(row: QueuedOutboxRow): Readonly<Record<string, unknown>> {
  return {
    outboxId: row.id,
    eventId: row.event_id,
    eventType: row.event_type,
    routingKey: row.routing_key,
    payload: parseJsonObject(row.payload_json),
  };
}

function markOutboxPublished(database: ApiDatabaseConnection, outboxId: string): void {
  database.sqlite
    .query(
      "UPDATE outbox SET status = 'published', attempts = attempts + 1, last_error = NULL, published_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
    )
    .run(outboxId);
}

function markOutboxFailed(database: ApiDatabaseConnection, outboxId: string, error: string): void {
  database.sqlite
    .query("UPDATE outbox SET status = 'failed', attempts = attempts + 1, last_error = ? WHERE id = ?")
    .run(error, outboxId);
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}
