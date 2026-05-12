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

export type ClaimNextTaskInput = {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeProvider?: string | null;
};

export type ClaimedTaskRecord = TaskRecord & {
  readonly status: "running";
};

export type ClaimedSessionRecord = SessionRecord & {
  readonly status: "starting";
  readonly runtimeProvider: string | null;
};

export type ClaimNextTaskResult =
  | {
      readonly ok: true;
      readonly task: ClaimedTaskRecord;
      readonly session: ClaimedSessionRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | { readonly ok: false; readonly reason: "no_eligible_task" };

export type RecordFinalAssistantResponseInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type FinalAssistantResponseResult =
  | { readonly ok: true; readonly event: EventRecord }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "conflict"; readonly message: string } };

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

    claimNextTask(input: ClaimNextTaskInput = {}): ClaimNextTaskResult {
      return transaction(database, () => {
        const task = selectNextEligibleTask(database, input.projectId);
        if (!task) return { ok: false, reason: "no_eligible_task" } as const;

        const sessionId = input.sessionId ?? createId("session");
        const attemptNumber = nextSessionAttemptNumber(database, task.project_id, task.id);
        const runtimeProvider = input.runtimeProvider ?? null;

        database
          .query("UPDATE tasks SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ? AND status = 'queued'")
          .run(task.project_id, task.id);
        database
          .query(
            "INSERT INTO sessions (id, project_id, task_id, attempt_number, status, runtime_provider, started_at) VALUES (?, ?, ?, ?, 'starting', ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          )
          .run(sessionId, task.project_id, task.id, attemptNumber, runtimeProvider);

        const event = appendEvent(database, {
          projectId: task.project_id,
          taskId: task.id,
          sessionId,
          type: "task.claimed",
          payload: { taskId: task.id, sessionId, attemptNumber },
        });
        const outbox = enqueueOutbox(database, {
          projectId: task.project_id,
          eventId: event.id,
          routingKey: projectRoutingKey(task.project_id, "control"),
          payload: { eventId: event.id, type: event.type, taskId: task.id, sessionId },
        });

        return {
          ok: true,
          task: {
            id: task.id,
            projectId: task.project_id,
            displayId: task.display_id,
            title: task.title,
            status: "running",
          },
          session: {
            id: sessionId,
            projectId: task.project_id,
            taskId: task.id,
            attemptNumber,
            status: "starting",
            runtimeProvider,
          },
          event,
          outbox,
        } as const;
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

    recordFinalAssistantResponse(input: RecordFinalAssistantResponseInput): FinalAssistantResponseResult {
      const metadataJson = JSON.stringify(input.metadata ?? {});
      const current = database
        .query<
          { task_id: string; final_response_text: string | null; final_response_metadata_json: string | null },
          [string, string]
        >(
          "SELECT task_id, final_response_text, final_response_metadata_json FROM sessions WHERE project_id = ? AND id = ?",
        )
        .get(input.projectId, input.sessionId);

      if (!current) {
        return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      }
      if (current.final_response_text !== null || current.final_response_metadata_json !== null) {
        if (current.final_response_text === input.text && current.final_response_metadata_json === metadataJson) {
          const event = appendEvent(database, {
            projectId: input.projectId,
            taskId: current.task_id,
            sessionId: input.sessionId,
            type: "session.final_response.idempotent",
            payload: { sessionId: input.sessionId },
          });
          return { ok: true, event };
        }

        return {
          ok: false,
          error: { code: "conflict", message: "final assistant response already recorded with different content" },
        };
      }

      return transaction(database, () => {
        database
          .query(
            "UPDATE sessions SET final_response_text = ?, final_response_metadata_json = ?, final_response_recorded_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?",
          )
          .run(input.text, metadataJson, input.projectId, input.sessionId);

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: current.task_id,
          sessionId: input.sessionId,
          type: "session.final_response.recorded",
          payload: { sessionId: input.sessionId },
        });
        return { ok: true, event } as const;
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

function selectNextEligibleTask(
  database: WebSandboxSqliteDatabase,
  projectId?: string,
): { readonly id: string; readonly project_id: string; readonly display_id: number; readonly title: string } | null {
  const sql = `
    SELECT t.id, t.project_id, t.display_id, t.title
    FROM tasks t
    JOIN projects p ON p.id = t.project_id
    WHERE t.status = 'queued'
      AND p.status = 'active'
      AND (? IS NULL OR t.project_id = ?)
      AND NOT EXISTS (
        SELECT 1 FROM sessions s
        WHERE s.project_id = t.project_id
          AND s.task_id = t.id
          AND s.status IN ('queued', 'starting', 'running')
      )
      AND NOT EXISTS (
        SELECT 1 FROM task_dependencies td
        JOIN tasks dependency ON dependency.project_id = td.project_id AND dependency.id = td.depends_on_task_id
        WHERE td.project_id = t.project_id
          AND td.task_id = t.id
          AND dependency.status != 'completed'
      )
    ORDER BY t.display_id ASC, t.created_at ASC, t.id ASC
    LIMIT 1
  `;

  return database
    .query<{ id: string; project_id: string; display_id: number; title: string }, [string | null, string | null]>(sql)
    .get(projectId ?? null, projectId ?? null);
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
