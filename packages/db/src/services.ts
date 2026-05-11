import type { WebSandboxSqliteDatabase } from "./migrations";

export type CanonicalStateServices = ReturnType<typeof createCanonicalStateServices>;

export type CreateProjectInput = {
  readonly id?: string;
  readonly slug: string;
  readonly name: string;
  readonly description?: string | null;
};

export type CreateTaskInput = {
  readonly id?: string;
  readonly projectId: string;
  readonly title: string;
  readonly description?: string | null;
};

export type AppendEventInput = {
  readonly id?: string;
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly commandId?: string | null;
  readonly type: string;
  readonly payload?: Readonly<Record<string, unknown>>;
};

export type CreateSessionAttemptInput = {
  readonly id?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status?: "queued" | "starting" | "running" | "succeeded" | "failed" | "canceled";
  readonly runtimeProvider?: string | null;
};

export type ProjectRecord = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
};

export type TaskRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: number;
  readonly title: string;
};

export type EventRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
};

export type OutboxRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly eventId: string | null;
  readonly routingKey: string;
};

export type SessionRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
};

export type CommandType = "start" | "stop" | "cancel" | "retry" | "cleanup" | "interrupt" | "steer";

export type RequestCommandInput = {
  readonly id?: string;
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly type: CommandType;
  readonly payload?: Readonly<Record<string, unknown>>;
  readonly requestedBy?: string | null;
};

export type CommandRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly type: CommandType;
};

export type CommandAdmissibilityError = {
  readonly code: "not_found" | "invalid_state" | "conflict" | "missing_scope";
  readonly message: string;
};

export type RequestCommandResult =
  | { readonly ok: true; readonly command: CommandRecord; readonly event: EventRecord; readonly outbox: OutboxRecord }
  | { readonly ok: false; readonly error: CommandAdmissibilityError };

export function createCanonicalStateServices(database: WebSandboxSqliteDatabase) {
  database.exec("PRAGMA foreign_keys = ON");

  return {
    createProject(input: CreateProjectInput): ProjectRecord {
      const id = input.id ?? createId("project");
      database
        .query("INSERT INTO projects (id, slug, name, description) VALUES (?, ?, ?, ?)")
        .run(id, input.slug, input.name, input.description ?? null);

      return { id, slug: input.slug, name: input.name };
    },

    createTask(input: CreateTaskInput): { readonly task: TaskRecord; readonly event: EventRecord; readonly outbox: OutboxRecord } {
      return transaction(database, () => {
        const taskId = input.id ?? createId("task");
        const displayId = allocateTaskDisplayId(database, input.projectId);

        database
          .query("INSERT INTO tasks (id, project_id, display_id, title, description) VALUES (?, ?, ?, ?, ?)")
          .run(taskId, input.projectId, displayId, input.title, input.description ?? null);

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId,
          type: "task.created",
          payload: { taskId, displayId, title: input.title },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, type: event.type },
        });

        return {
          task: { id: taskId, projectId: input.projectId, displayId, title: input.title },
          event,
          outbox,
        };
      });
    },

    appendEvent(input: AppendEventInput): EventRecord {
      return appendEvent(database, input);
    },

    createSessionAttempt(
      input: CreateSessionAttemptInput,
    ): { readonly session: SessionRecord; readonly event: EventRecord; readonly outbox: OutboxRecord } {
      return transaction(database, () => {
        const sessionId = input.id ?? createId("session");
        const attemptNumber = nextSessionAttemptNumber(database, input.projectId, input.taskId);

        database
          .query(
            "INSERT INTO sessions (id, project_id, task_id, attempt_number, status, runtime_provider) VALUES (?, ?, ?, ?, ?, ?)",
          )
          .run(sessionId, input.projectId, input.taskId, attemptNumber, input.status ?? "queued", input.runtimeProvider ?? null);

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId,
          type: "session.created",
          payload: { sessionId, taskId: input.taskId, attemptNumber },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "control"),
          payload: { eventId: event.id, type: event.type },
        });

        return {
          session: { id: sessionId, projectId: input.projectId, taskId: input.taskId, attemptNumber },
          event,
          outbox,
        };
      });
    },

    requestCommand(input: RequestCommandInput): RequestCommandResult {
      const admissibility = validateCommand(database, input);
      if (!admissibility.ok) return admissibility;

      return transaction(database, () => {
        const commandId = input.id ?? createId("command");
        database
          .query(
            "INSERT INTO orchestrator_commands (id, project_id, task_id, session_id, type, payload_json, requested_by) VALUES (?, ?, ?, ?, ?, ?, ?)",
          )
          .run(
            commandId,
            input.projectId,
            input.taskId ?? null,
            input.sessionId ?? null,
            input.type,
            JSON.stringify(input.payload ?? {}),
            input.requestedBy ?? null,
          );

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          commandId,
          type: "command.queued",
          payload: { commandId, type: input.type },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "control"),
          payload: { eventId: event.id, commandId, type: input.type },
        });

        return {
          ok: true,
          command: {
            id: commandId,
            projectId: input.projectId,
            taskId: input.taskId ?? null,
            sessionId: input.sessionId ?? null,
            type: input.type,
          },
          event,
          outbox,
        } as const;
      });
    },
  };
}

function appendEvent(database: WebSandboxSqliteDatabase, input: AppendEventInput): EventRecord {
  const eventId = input.id ?? createId("event");
  const payloadJson = JSON.stringify(input.payload ?? {});

  database
    .query(
      "INSERT INTO events (id, project_id, task_id, session_id, command_id, type, payload_json) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      eventId,
      input.projectId,
      input.taskId ?? null,
      input.sessionId ?? null,
      input.commandId ?? null,
      input.type,
      payloadJson,
    );

  return { id: eventId, projectId: input.projectId, type: input.type };
}

function enqueueOutbox(
  database: WebSandboxSqliteDatabase,
  input: {
    readonly id?: string;
    readonly projectId: string;
    readonly eventId: string;
    readonly routingKey: string;
    readonly payload: Readonly<Record<string, unknown>>;
  },
): OutboxRecord {
  const outboxId = input.id ?? createId("outbox");

  database
    .query("INSERT INTO outbox (id, project_id, event_id, routing_key, payload_json) VALUES (?, ?, ?, ?, ?)")
    .run(outboxId, input.projectId, input.eventId, input.routingKey, JSON.stringify(input.payload));

  return { id: outboxId, projectId: input.projectId, eventId: input.eventId, routingKey: input.routingKey };
}

function allocateTaskDisplayId(database: WebSandboxSqliteDatabase, projectId: string): number {
  const row = database
    .query<{ task_display_sequence: number }, [string]>("SELECT task_display_sequence FROM projects WHERE id = ?")
    .get(projectId);

  if (!row) {
    throw new Error(`project not found: ${projectId}`);
  }

  const displayId = row.task_display_sequence + 1;
  database.query("UPDATE projects SET task_display_sequence = ? WHERE id = ?").run(displayId, projectId);
  return displayId;
}

function nextSessionAttemptNumber(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): number {
  const row = database
    .query<{ max_attempt: number | null }, [string, string]>(
      "SELECT MAX(attempt_number) AS max_attempt FROM sessions WHERE project_id = ? AND task_id = ?",
    )
    .get(projectId, taskId);

  return (row?.max_attempt ?? 0) + 1;
}

function validateCommand(database: WebSandboxSqliteDatabase, input: RequestCommandInput): { readonly ok: true } | { readonly ok: false; readonly error: CommandAdmissibilityError } {
  const task = input.taskId ? readTaskState(database, input.projectId, input.taskId) : null;
  const session = input.sessionId ? readSessionState(database, input.projectId, input.sessionId) : null;

  if (input.taskId && !task) return commandError("not_found", `task not found: ${input.taskId}`);
  if (input.sessionId && !session) return commandError("not_found", `session not found: ${input.sessionId}`);

  const conflict = database
    .query<{ id: string }, [string, string | null, string | null, string]>(
      "SELECT id FROM orchestrator_commands WHERE project_id = ? AND task_id IS ? AND session_id IS ? AND type = ? AND status IN ('queued', 'running') LIMIT 1",
    )
    .get(input.projectId, input.taskId ?? null, input.sessionId ?? null, input.type);
  if (conflict) return commandError("conflict", `conflicting command already queued or running: ${conflict.id}`);

  switch (input.type) {
    case "start":
      if (!task) return commandError("missing_scope", "start requires a task");
      if (task.status !== "queued") return commandError("invalid_state", `start requires queued task; got ${task.status}`);
      return { ok: true };
    case "cancel":
      if (!task) return commandError("missing_scope", "cancel requires a task");
      if (["completed", "failed"].includes(task.status)) {
        return commandError("invalid_state", `cancel requires active task; got ${task.status}`);
      }
      return { ok: true };
    case "retry":
      if (!task) return commandError("missing_scope", "retry requires a task");
      if (!["failed", "completed"].includes(task.status)) {
        return commandError("invalid_state", `retry requires terminal task; got ${task.status}`);
      }
      return { ok: true };
    case "stop":
    case "interrupt":
    case "steer":
      if (!session) return commandError("missing_scope", `${input.type} requires a session`);
      if (session.status !== "running") {
        return commandError("invalid_state", `${input.type} requires running session; got ${session.status}`);
      }
      return { ok: true };
    case "cleanup":
      if (!session) return commandError("missing_scope", "cleanup requires a session");
      if (!["succeeded", "failed", "canceled"].includes(session.status)) {
        return commandError("invalid_state", `cleanup requires terminal session; got ${session.status}`);
      }
      return { ok: true };
  }
}

function readTaskState(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): { readonly status: string } | null {
  return database.query<{ status: string }, [string, string]>("SELECT status FROM tasks WHERE project_id = ? AND id = ?").get(projectId, taskId);
}

function readSessionState(database: WebSandboxSqliteDatabase, projectId: string, sessionId: string): { readonly status: string } | null {
  return database
    .query<{ status: string }, [string, string]>("SELECT status FROM sessions WHERE project_id = ? AND id = ?")
    .get(projectId, sessionId);
}

function commandError(code: CommandAdmissibilityError["code"], message: string): { readonly ok: false; readonly error: CommandAdmissibilityError } {
  return { ok: false, error: { code, message } };
}

function transaction<T>(database: WebSandboxSqliteDatabase, run: () => T): T {
  database.exec("BEGIN IMMEDIATE");
  try {
    const result = run();
    database.exec("COMMIT");
    return result;
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

function projectRoutingKey(projectId: string, suffix: "control" | "events"): string {
  return `project.${projectId}.${suffix}`;
}

function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}
