import type { AppConfig } from "@agent-pool/config";
import type { ProjectQueueDeclaration, RabbitMqAdapter } from "@agent-pool/queue";

import type { createApiBackendServices } from "./backend-services";
import type { ApiDatabaseConnection } from "./database";

type ApiBackendServices = ReturnType<typeof createApiBackendServices>;

export type SmokeFixtureOptions = {
  readonly config: AppConfig;
  readonly database: ApiDatabaseConnection;
};

export type SmokeSeedFixtureOptions = SmokeFixtureOptions & {
  readonly queue: RabbitMqAdapter;
  readonly services: ApiBackendServices;
};

export type SmokeFixtureIds = {
  readonly projectId: string;
  readonly taskId: string;
};

export type SmokeSeedResult = SmokeFixtureIds & {
  readonly project: ProjectStatusRecord;
  readonly task: TaskStatusRecord;
  readonly queues: readonly ProjectQueueDeclaration[];
  readonly created: {
    readonly project: boolean;
    readonly task: boolean;
  };
  readonly outbox: SmokeOutboxStatus;
};

export type SmokeStatusResult = SmokeFixtureIds & {
  readonly project: ProjectStatusRecord | null;
  readonly task: TaskStatusRecord | null;
  readonly sessions: {
    readonly total: number;
    readonly queued: number;
    readonly starting: number;
    readonly running: number;
    readonly succeeded: number;
    readonly failed: number;
    readonly canceled: number;
    readonly latest: SessionStatusRecord | null;
  };
  readonly heartbeat: {
    readonly fresh: number;
    readonly stale: number;
    readonly lost: number;
    readonly latestAt: string | null;
  };
  readonly output: {
    readonly streams: readonly LogStreamStatusRecord[];
    readonly events: number;
    readonly totalByteOffset: number;
    readonly totalLineCount: number;
  };
  readonly artifacts: {
    readonly total: number;
    readonly documents: number;
    readonly finalResponseUrls: number;
    readonly items: readonly ArtifactStatusRecord[];
  };
  readonly finalResponse: {
    readonly recorded: boolean;
    readonly sessions: number;
    readonly artifacts: number;
  };
  readonly completion: {
    readonly completed: boolean;
    readonly events: number;
  };
  readonly failure: {
    readonly failed: boolean;
    readonly events: number;
  };
  readonly cleanup: {
    readonly completed: boolean;
    readonly events: number;
  };
  readonly events: Record<string, number>;
  readonly outbox: SmokeOutboxStatus;
};

type ProjectStatusRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly status: string;
};

type TaskStatusRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: number;
  readonly title: string;
  readonly status: string;
};

type SessionStatusRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: string;
  readonly runtimeProvider: string | null;
  readonly runtimeSessionId: string | null;
  readonly heartbeatStatus: string;
  readonly lastHeartbeatAt: string | null;
  readonly finalResponseRecordedAt: string | null;
};

type LogStreamStatusRecord = {
  readonly id: string;
  readonly kind: string;
  readonly byteOffset: number;
  readonly lineCount: number;
};

type ArtifactStatusRecord = {
  readonly id: string;
  readonly kind: string;
  readonly uri: string;
  readonly title: string | null;
};

type SmokeOutboxStatus = {
  readonly queued: number;
  readonly published: number;
  readonly failed: number;
  readonly total: number;
};

export function isSmokeFixtureEnabled(config: AppConfig): boolean {
  return config.authMode === "test" || config.controlPlane.smokeEnabled;
}

export function smokeFixtureIds(config: AppConfig): SmokeFixtureIds {
  const projectId = config.controlPlane.smokeProjectId;

  return {
    projectId,
    taskId: `${projectId}-task-1`,
  };
}

export async function seedSmokeFixture(options: SmokeSeedFixtureOptions): Promise<SmokeSeedResult> {
  const ids = smokeFixtureIds(options.config);
  let project = readProject(options.database, ids.projectId);
  let queues: readonly ProjectQueueDeclaration[];
  let projectCreated = false;

  if (!project) {
    const result = options.services.createProjectWithQueues({
      id: ids.projectId,
      slug: ids.projectId,
      name: "Compose Smoke",
      description: "Headless compose smoke fixture",
    });
    queues = result.queues;
    project = readProject(options.database, ids.projectId) ?? {
      ...result.project,
      status: "active",
    };
    projectCreated = true;
  } else {
    queues = options.queue.declareProjectQueues(ids.projectId);
  }

  let task = readTask(options.database, ids.projectId, ids.taskId);
  let taskCreated = false;
  if (!task) {
    options.services.createTask({
      id: ids.taskId,
      projectId: ids.projectId,
      title: "Run headless compose smoke",
      description: "Deterministic fixture task for the headless compose control-plane smoke.",
    });
    task = readTask(options.database, ids.projectId, ids.taskId);
    taskCreated = true;
  }

  await options.queue.flush?.();

  if (!task) {
    throw new Error(`failed to create smoke task: ${ids.taskId}`);
  }

  return {
    ...ids,
    project,
    task,
    queues,
    created: {
      project: projectCreated,
      task: taskCreated,
    },
    outbox: readOutboxStatus(options.database, ids.projectId),
  };
}

export function readSmokeFixtureStatus(options: SmokeFixtureOptions): SmokeStatusResult {
  const ids = smokeFixtureIds(options.config);
  const project = readProject(options.database, ids.projectId);
  const task = readTask(options.database, ids.projectId, ids.taskId);
  const sessions = readSessionRows(options.database, ids.projectId, ids.taskId);
  const eventCounts = readEventCounts(options.database, ids.projectId, ids.taskId);
  const outputStreams = readLogStreams(options.database, ids.projectId, ids.taskId);
  const artifacts = readArtifacts(options.database, ids.projectId, ids.taskId);
  const sessionCounts = countBy(sessions, "status");
  const heartbeatCounts = countBy(sessions, "heartbeatStatus");
  const finalResponseSessions = sessions.filter((session) => session.finalResponseRecordedAt !== null).length;
  const finalResponseArtifacts = artifacts.filter((artifact) => artifact.kind === "final_response_url").length;
  const completionEvents = (eventCounts["session.completed"] ?? 0) + (eventCounts["session.completed.idempotent"] ?? 0);
  const failureEvents = (eventCounts["session.failed"] ?? 0) + (eventCounts["session.failed.idempotent"] ?? 0);
  const cleanupEvents = (eventCounts["session.cleanup"] ?? 0) + (eventCounts["session.cleanup.idempotent"] ?? 0);

  return {
    ...ids,
    project,
    task,
    sessions: {
      total: sessions.length,
      queued: sessionCounts.queued ?? 0,
      starting: sessionCounts.starting ?? 0,
      running: sessionCounts.running ?? 0,
      succeeded: sessionCounts.succeeded ?? 0,
      failed: sessionCounts.failed ?? 0,
      canceled: sessionCounts.canceled ?? 0,
      latest: sessions[0] ?? null,
    },
    heartbeat: {
      fresh: heartbeatCounts.fresh ?? 0,
      stale: heartbeatCounts.stale ?? 0,
      lost: heartbeatCounts.lost ?? 0,
      latestAt: sessions.find((session) => session.lastHeartbeatAt !== null)?.lastHeartbeatAt ?? null,
    },
    output: {
      streams: outputStreams,
      events: eventCounts["session.output"] ?? 0,
      totalByteOffset: outputStreams.reduce((sum, stream) => sum + stream.byteOffset, 0),
      totalLineCount: outputStreams.reduce((sum, stream) => sum + stream.lineCount, 0),
    },
    artifacts: {
      total: artifacts.length,
      documents: artifacts.filter((artifact) => artifact.kind === "document").length,
      finalResponseUrls: finalResponseArtifacts,
      items: artifacts,
    },
    finalResponse: {
      recorded: finalResponseSessions > 0,
      sessions: finalResponseSessions,
      artifacts: finalResponseArtifacts,
    },
    completion: {
      completed: task?.status === "completed" || sessions.some((session) => session.status === "succeeded"),
      events: completionEvents,
    },
    failure: {
      failed: task?.status === "failed" || task?.status === "blocked" || sessions.some((session) => session.status === "failed"),
      events: failureEvents,
    },
    cleanup: {
      completed: cleanupEvents > 0,
      events: cleanupEvents,
    },
    events: eventCounts,
    outbox: readOutboxStatus(options.database, ids.projectId),
  };
}

function readProject(database: ApiDatabaseConnection, projectId: string): ProjectStatusRecord | null {
  return database.sqlite
    .query<ProjectStatusRecord, [string]>(
      "SELECT id, slug, name, status FROM projects WHERE id = ?",
    )
    .get(projectId) ?? null;
}

function readTask(database: ApiDatabaseConnection, projectId: string, taskId: string): TaskStatusRecord | null {
  const row = database.sqlite
    .query<
      {
        id: string;
        project_id: string;
        display_id: number;
        title: string;
        status: string;
      },
      [string, string]
    >(
      "SELECT id, project_id, display_id, title, status FROM tasks WHERE project_id = ? AND id = ?",
    )
    .get(projectId, taskId);

  return row
    ? {
        id: row.id,
        projectId: row.project_id,
        displayId: row.display_id,
        title: row.title,
        status: row.status,
      }
    : null;
}

function readSessionRows(database: ApiDatabaseConnection, projectId: string, taskId: string): readonly SessionStatusRecord[] {
  return database.sqlite
    .query<
      {
        id: string;
        project_id: string;
        task_id: string;
        status: string;
        runtime_provider: string | null;
        runtime_session_id: string | null;
        heartbeat_status: string;
        last_heartbeat_at: string | null;
        final_response_recorded_at: string | null;
      },
      [string, string]
    >(
      `
        SELECT
          id,
          project_id,
          task_id,
          status,
          runtime_provider,
          runtime_session_id,
          heartbeat_status,
          last_heartbeat_at,
          final_response_recorded_at
        FROM sessions
        WHERE project_id = ? AND task_id = ?
        ORDER BY created_at DESC, id DESC
      `,
    )
    .all(projectId, taskId)
    .map((row) => ({
      id: row.id,
      projectId: row.project_id,
      taskId: row.task_id,
      status: row.status,
      runtimeProvider: row.runtime_provider,
      runtimeSessionId: row.runtime_session_id,
      heartbeatStatus: row.heartbeat_status,
      lastHeartbeatAt: row.last_heartbeat_at,
      finalResponseRecordedAt: row.final_response_recorded_at,
    }));
}

function readLogStreams(database: ApiDatabaseConnection, projectId: string, taskId: string): readonly LogStreamStatusRecord[] {
  return database.sqlite
    .query<
      {
        id: string;
        kind: string;
        byte_offset: number;
        line_count: number;
      },
      [string, string]
    >(
      "SELECT id, kind, byte_offset, line_count FROM log_streams WHERE project_id = ? AND task_id = ? ORDER BY kind, id",
    )
    .all(projectId, taskId)
    .map((row) => ({
      id: row.id,
      kind: row.kind,
      byteOffset: row.byte_offset,
      lineCount: row.line_count,
    }));
}

function readArtifacts(database: ApiDatabaseConnection, projectId: string, taskId: string): readonly ArtifactStatusRecord[] {
  return database.sqlite
    .query<
      {
        id: string;
        kind: string;
        uri: string;
        title: string | null;
      },
      [string, string]
    >(
      "SELECT id, kind, uri, title FROM artifacts WHERE project_id = ? AND task_id = ? ORDER BY kind, uri",
    )
    .all(projectId, taskId);
}

function readEventCounts(database: ApiDatabaseConnection, projectId: string, taskId: string): Record<string, number> {
  const rows = database.sqlite
    .query<{ type: string; count: number }, [string, string]>(
      "SELECT type, COUNT(*) AS count FROM events WHERE project_id = ? AND task_id = ? GROUP BY type ORDER BY type",
    )
    .all(projectId, taskId);

  return Object.fromEntries(rows.map((row) => [row.type, row.count]));
}

function readOutboxStatus(database: ApiDatabaseConnection, projectId: string): SmokeOutboxStatus {
  const rows = database.sqlite
    .query<{ status: "queued" | "published" | "failed"; count: number }, [string]>(
      "SELECT status, COUNT(*) AS count FROM outbox WHERE project_id = ? GROUP BY status",
    )
    .all(projectId);
  const counts = Object.fromEntries(rows.map((row) => [row.status, row.count])) as Partial<Record<"queued" | "published" | "failed", number>>;
  const queued = counts.queued ?? 0;
  const published = counts.published ?? 0;
  const failed = counts.failed ?? 0;

  return {
    queued,
    published,
    failed,
    total: queued + published + failed,
  };
}

function countBy<TValue extends Record<TKey, string>, TKey extends keyof TValue>(
  values: readonly TValue[],
  key: TKey,
): Record<string, number> {
  return values.reduce<Record<string, number>>((counts, value) => {
    counts[value[key]] = (counts[value[key]] ?? 0) + 1;
    return counts;
  }, {});
}
