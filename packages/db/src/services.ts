import type { WebSandboxSqliteDatabase } from "./migrations";

const DEFAULT_BRIDGE_CALLBACK_BASE_URL = "http://127.0.0.1:3000";
const DEFAULT_BRIDGE_SESSION_TOKEN_HEADER = "x-agent-pool-session-token";

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
  readonly runtimeSource?: TaskRuntimeSourceMetadata | null;
  readonly priority?: number | null;
};

export type TaskRuntimeSourceMetadata = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
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
  readonly priority: number;
  readonly runtimeSource: TaskRuntimeSourceMetadata | null;
};

export type PublicProjectSummary = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly taskCounts: Readonly<Record<"queued" | "running" | "blocked" | "completed" | "failed", number>>;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PublicTaskSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly runtimeSource: TaskRuntimeSourceMetadata | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestSession: PublicSessionSummary | null;
  readonly pendingCommands: readonly PublicCommandSummary[];
};

export type PublicSessionSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly attemptNumber: number;
  readonly status: string;
  readonly runtimeProvider: string | null;
  readonly runtimeSessionId: string | null;
  readonly createdAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly finalResponseRecordedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatStatus: string;
  readonly staleAt: string | null;
  readonly lostAt: string | null;
};

export type PublicCommandSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly type: CommandType;
  readonly status: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly errorMessage: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
};

export type PublicArtifactSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly uri: string;
  readonly title: string | null;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

export type PublicEventSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly commandId: string | null;
  readonly type: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly createdAt: string;
};

export type PublicLogStreamSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly byteOffset: number;
  readonly lineCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PublicTaskDetail = PublicTaskSummary & {
  readonly sessions: readonly PublicSessionSummary[];
  readonly artifacts: readonly PublicArtifactSummary[];
  readonly events: readonly PublicEventSummary[];
  readonly logStreams: readonly PublicLogStreamSummary[];
};

export type ListPublicEventsInput = {
  readonly projectId: string;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly dispatchOnly?: boolean;
  readonly lastEventId?: string | null;
};

export type ReadTaskDetailInput = {
  readonly projectId: string;
  readonly taskId: string;
};

export type ReadTaskDetailResult =
  | { readonly ok: true; readonly task: PublicTaskDetail }
  | { readonly ok: false; readonly error: { readonly code: "not_found"; readonly message: string } };

export type TaskMutationResult =
  | { readonly ok: true; readonly task: PublicTaskDetail; readonly event: EventRecord; readonly outbox: OutboxRecord; readonly idempotent: boolean }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

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

export type SteeringAttachmentReference = {
  readonly key: string;
  readonly bucket?: string | null;
  readonly fileName?: string | null;
  readonly contentType?: string | null;
};

export type RequestSteeringInput = {
  readonly id?: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly body: string;
  readonly attachments?: readonly SteeringAttachmentReference[];
  readonly requestedBy?: string | null;
};

export type CommandRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly type: CommandType;
};

export type SteeringMessageRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly commandId: string | null;
  readonly body: string;
  readonly status: "queued" | "delivered" | "failed" | "canceled";
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
};

export type BridgeSteeringMessageRecord = {
  readonly id: string;
  readonly body: string;
  readonly commandId: string | null;
  readonly attachments: readonly SteeringAttachmentReference[];
};

export type RequestSteeringResult =
  | {
      readonly ok: true;
      readonly steering: SteeringMessageRecord;
      readonly command: CommandRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | {
      readonly ok: false;
      readonly error: { readonly code: "not_found" | "missing_scope" | "invalid_state" | "conflict" | "validation_error"; readonly message: string };
    };

export type PollQueuedSteeringInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
};

export type PollQueuedSteeringResult =
  | { readonly ok: true; readonly messages: readonly BridgeSteeringMessageRecord[] }
  | { readonly ok: false; readonly error: { readonly code: "not_found"; readonly message: string } };

export type ReportSteeringDeliveryInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly steeringMessageId: string;
  readonly status: "delivered" | "failed";
  readonly errorMessage?: string | null;
};

export type ReportSteeringDeliveryResult =
  | {
      readonly ok: true;
      readonly steering: SteeringMessageRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
      readonly idempotent: boolean;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type ClaimedCommandRecord = CommandRecord & {
  readonly status: "running";
  readonly payload: Readonly<Record<string, unknown>>;
  readonly claimedAt: string;
};

export type ClaimNextCommandInput = {
  readonly projectId?: string;
};

export type ClaimNextCommandResult =
  | { readonly ok: true; readonly command: ClaimedCommandRecord; readonly event: EventRecord; readonly outbox: OutboxRecord }
  | { readonly ok: false; readonly reason: "no_queued_command" };

export type CommandAdmissibilityError = {
  readonly code: "not_found" | "invalid_state" | "conflict" | "missing_scope";
  readonly message: string;
};

export type RequestCommandResult =
  | { readonly ok: true; readonly command: CommandRecord; readonly event: EventRecord; readonly outbox: OutboxRecord }
  | { readonly ok: false; readonly error: CommandAdmissibilityError };

export type CommandReportInput = {
  readonly projectId: string;
  readonly commandId: string;
  readonly errorMessage?: string | null;
};

export type CommandReportRecord = CommandRecord & {
  readonly status: "running" | "succeeded" | "failed";
  readonly errorMessage: string | null;
};

export type CommandReportResult =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly command: CommandReportRecord;
      readonly event?: EventRecord;
      readonly outbox?: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state" | "conflict"; readonly message: string } };

export type ClaimNextTaskInput = {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeProvider?: string | null;
  readonly bridgeCallbackBaseUrl?: string | null;
  readonly bridgeSessionTokenHeaderName?: string | null;
  readonly bridgeSessionToken?: string | null;
};

export type ClaimedTaskRecord = TaskRecord & {
  readonly status: "running";
};

export type ClaimedSessionRecord = SessionRecord & {
  readonly status: "starting";
  readonly runtimeProvider: string | null;
  readonly bridge: BridgeSessionCallbackConfig;
};

export type BridgeSessionCallbackConfig = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly callbackBaseUrl: string;
  readonly sessionToken: {
    readonly headerName: string;
    readonly token: string;
  };
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

export type StartupReportInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runtimeSessionId?: string | null;
  readonly errorMessage?: string | null;
};

export type StartupReportSessionRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: "running" | "failed";
  readonly runtimeSessionId: string | null;
};

export type StartupReportTaskRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly status: "running" | "blocked";
};

export type StartupReportResult =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly session: StartupReportSessionRecord;
      readonly task: StartupReportTaskRecord;
      readonly event?: EventRecord;
      readonly outbox?: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state" | "conflict"; readonly message: string } };

export type SessionHeartbeatInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly observedAt?: string | null;
};

export type SessionHeartbeatRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: "starting" | "running";
  readonly heartbeatStatus: "fresh";
  readonly lastHeartbeatAt: string;
  readonly staleAt: null;
  readonly lostAt: null;
};

export type SessionHeartbeatResult =
  | {
      readonly ok: true;
      readonly session: SessionHeartbeatRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type HeartbeatReconcileInput = {
  readonly projectId?: string | null;
  readonly staleBefore: string;
  readonly lostBefore: string;
  readonly now?: string | null;
};

export type ReconciledHeartbeatSessionRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: "starting" | "running" | "failed";
  readonly heartbeatStatus: "stale" | "lost";
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatBasisAt: string;
};

export type HeartbeatReconcileResult = {
  readonly ok: true;
  readonly stale: readonly ReconciledHeartbeatSessionRecord[];
  readonly lost: readonly ReconciledHeartbeatSessionRecord[];
  readonly events: readonly EventRecord[];
  readonly outbox: readonly OutboxRecord[];
};

export type RecordFinalAssistantResponseInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly urlCandidates?: readonly string[];
};

export type ArtifactRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly kind: "final_response_url" | "document";
  readonly uri: string;
  readonly title: string | null;
};

export type FinalAssistantResponseResult =
  | { readonly ok: true; readonly event: EventRecord; readonly artifacts: readonly ArtifactRecord[] }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "conflict"; readonly message: string } };

export type RecordDocumentArtifactInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly title?: string | null;
  readonly contentType?: string | null;
  readonly sizeBytes?: number | null;
};

export type RecordDocumentArtifactResult =
  | {
      readonly ok: true;
      readonly artifact: ArtifactRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
      readonly idempotent: boolean;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type ReadBridgeSessionCallbackConfigInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
};

export type ReadBridgeSessionCallbackConfigResult =
  | { readonly ok: true; readonly bridge: BridgeSessionCallbackConfig }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type RecordSessionOutputInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly stream: "stdout" | "stderr" | "combined" | "system";
  readonly sequence: number;
  readonly byteOffset: number;
  readonly text: string;
  readonly observedAt?: string | null;
};

export type SessionOutputRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly stream: "stdout" | "stderr" | "combined" | "system";
  readonly byteOffset: number;
  readonly lineCount: number;
};

export type RecordSessionOutputResult =
  | {
      readonly ok: true;
      readonly output: SessionOutputRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type CompleteSessionInput = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly observedAt?: string | null;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type FailSessionInput = CompleteSessionInput & {
  readonly errorMessage: string;
};

export type CleanupSessionInput = CompleteSessionInput & {
  readonly reason?: string | null;
};

export type TerminalSessionRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly status: "succeeded" | "failed";
};

export type TerminalTaskRecord = {
  readonly id: string;
  readonly projectId: string;
  readonly status: "completed" | "failed" | "blocked";
};

export type SessionTerminalResult =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly session: TerminalSessionRecord;
      readonly task: TerminalTaskRecord;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

export type SessionCleanupResult =
  | {
      readonly ok: true;
      readonly idempotent: boolean;
      readonly event: EventRecord;
      readonly outbox: OutboxRecord;
    }
  | { readonly ok: false; readonly error: { readonly code: "not_found" | "invalid_state"; readonly message: string } };

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

    listProjects(): readonly PublicProjectSummary[] {
      return listPublicProjects(database);
    },

    listProjectTasks(input: { readonly projectId: string }): readonly PublicTaskSummary[] {
      return listPublicTaskSummaries(database, input.projectId);
    },

    listPublicEvents(input: ListPublicEventsInput): readonly PublicEventSummary[] {
      return listPublicEvents(database, input);
    },

    readTaskDetail(input: ReadTaskDetailInput): ReadTaskDetailResult {
      const task = readPublicTaskDetail(database, input.projectId, input.taskId);
      if (!task) {
        return { ok: false, error: { code: "not_found", message: `task not found: ${input.taskId}` } };
      }

      return { ok: true, task };
    },

    createTask(input: CreateTaskInput): { readonly task: TaskRecord; readonly event: EventRecord; readonly outbox: OutboxRecord } {
      return transaction(database, () => {
        const taskId = input.id ?? createId("task");
        const displayId = allocateTaskDisplayId(database, input.projectId);

        const runtimeSource = sanitizeTaskRuntimeSource(input.runtimeSource);
        const priority = normalizeTaskPriority(input.priority);

        database
          .query("INSERT INTO tasks (id, project_id, display_id, title, description, runtime_source_json, priority) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run(
            taskId,
            input.projectId,
            displayId,
            input.title,
            input.description ?? null,
            runtimeSource ? JSON.stringify(runtimeSource) : null,
            priority,
          );

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId,
          type: "task.created",
          payload: { taskId, displayId, title: input.title, runtimeSource, priority },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, type: event.type },
        });

        return {
          task: { id: taskId, projectId: input.projectId, displayId, title: input.title, priority, runtimeSource },
          event,
          outbox,
        };
      });
    },

    updateTaskPriority(input: { readonly projectId: string; readonly taskId: string; readonly priority: number }): TaskMutationResult {
      const priority = normalizeTaskPriority(input.priority);
      return transaction(database, () => {
        const current = readTaskState(database, input.projectId, input.taskId);

        if (!current) {
          return { ok: false, error: { code: "not_found", message: `task not found: ${input.taskId}` } };
        }

        const idempotent = current.priority === priority;
        if (!idempotent) {
          database
            .query("UPDATE tasks SET priority = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
            .run(priority, input.projectId, input.taskId);
        }

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          type: idempotent ? "task.priority_updated.idempotent" : "task.priority_updated",
          payload: { taskId: input.taskId, priority },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, taskId: input.taskId, type: event.type },
        });

        const task = readPublicTaskDetail(database, input.projectId, input.taskId);
        if (!task) {
          return { ok: false, error: { code: "not_found", message: `task not found: ${input.taskId}` } };
        }

        return { ok: true, task, event, outbox, idempotent } as const;
      });
    },

    backlogTask(input: { readonly projectId: string; readonly taskId: string }): TaskMutationResult {
      return updateTaskStatus(database, {
        projectId: input.projectId,
        taskId: input.taskId,
        targetStatus: "queued",
        eventType: "task.backlogged",
        idempotentEventType: "task.backlogged.idempotent",
        allowedCurrentStatuses: ["blocked", "failed"],
        idempotentCurrentStatus: "queued",
      });
    },

    unblockTask(input: { readonly projectId: string; readonly taskId: string }): TaskMutationResult {
      return updateTaskStatus(database, {
        projectId: input.projectId,
        taskId: input.taskId,
        targetStatus: "queued",
        eventType: "task.unblocked",
        idempotentEventType: "task.unblocked.idempotent",
        allowedCurrentStatuses: ["blocked"],
        idempotentCurrentStatus: "queued",
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
        const bridge = bridgeCallbackConfig({
          projectId: task.project_id,
          taskId: task.id,
          sessionId,
          callbackBaseUrl: input.bridgeCallbackBaseUrl,
          sessionTokenHeaderName: input.bridgeSessionTokenHeaderName,
          sessionToken: input.bridgeSessionToken,
        });

        database
          .query("UPDATE tasks SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ? AND status = 'queued'")
          .run(task.project_id, task.id);
        database
          .query(
            "INSERT INTO sessions (id, project_id, task_id, attempt_number, status, runtime_provider, bridge_callback_base_url, bridge_session_token_header, bridge_session_token, started_at) VALUES (?, ?, ?, ?, 'starting', ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))",
          )
          .run(
            sessionId,
            task.project_id,
            task.id,
            attemptNumber,
            runtimeProvider,
            bridge.callbackBaseUrl,
            bridge.sessionToken.headerName,
            bridge.sessionToken.token,
          );

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
            priority: task.priority,
            runtimeSource: readRuntimeSourceJson(task.runtime_source_json),
            status: "running",
          },
          session: {
            id: sessionId,
            projectId: task.project_id,
            taskId: task.id,
            attemptNumber,
            status: "starting",
            runtimeProvider,
            bridge,
          },
          event,
          outbox,
        } as const;
      });
    },

    claimNextCommand(input: ClaimNextCommandInput = {}): ClaimNextCommandResult {
      return transaction(database, () => {
        const command = selectNextQueuedCommand(database, input.projectId);
        if (!command) return { ok: false, reason: "no_queued_command" } as const;

        database
          .query(
            "UPDATE orchestrator_commands SET status = 'running', claimed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ? AND status = 'queued'",
          )
          .run(command.project_id, command.id);
        const claimed = database
          .query<
            {
              id: string;
              project_id: string;
              task_id: string | null;
              session_id: string | null;
              type: CommandType;
              payload_json: string;
              claimed_at: string;
            },
            [string, string]
          >(
            "SELECT id, project_id, task_id, session_id, type, payload_json, claimed_at FROM orchestrator_commands WHERE project_id = ? AND id = ?",
          )
          .get(command.project_id, command.id);

        if (!claimed) {
          throw new Error(`claimed command disappeared: ${command.id}`);
        }

        const event = appendEvent(database, {
          projectId: claimed.project_id,
          taskId: claimed.task_id,
          sessionId: claimed.session_id,
          commandId: claimed.id,
          type: "command.claimed",
          payload: { commandId: claimed.id, type: claimed.type },
        });
        const outbox = enqueueOutbox(database, {
          projectId: claimed.project_id,
          eventId: event.id,
          routingKey: projectRoutingKey(claimed.project_id, "control"),
          payload: { eventId: event.id, commandId: claimed.id, type: claimed.type },
        });

        return {
          ok: true,
          command: {
            id: claimed.id,
            projectId: claimed.project_id,
            taskId: claimed.task_id,
            sessionId: claimed.session_id,
            type: claimed.type,
            status: "running",
            payload: parseJsonObject(claimed.payload_json),
            claimedAt: claimed.claimed_at,
          },
          event,
          outbox,
        } as const;
      });
    },

    reportCommandStarted(input: CommandReportInput): CommandReportResult {
      return reportCommandTransition(database, input, "running");
    },

    reportCommandSucceeded(input: CommandReportInput): CommandReportResult {
      return reportCommandTransition(database, input, "succeeded");
    },

    reportCommandFailed(input: CommandReportInput): CommandReportResult {
      return reportCommandTransition(database, input, "failed");
    },

    reportStartupSucceeded(input: StartupReportInput): StartupReportResult {
      return reportStartupSucceeded(database, input);
    },

    reportStartupFailed(input: StartupReportInput): StartupReportResult {
      return reportStartupFailed(database, input);
    },

    reportSessionHeartbeat(input: SessionHeartbeatInput): SessionHeartbeatResult {
      return reportSessionHeartbeat(database, input);
    },

    reconcileLostSessions(input: HeartbeatReconcileInput): HeartbeatReconcileResult {
      return reconcileLostSessions(database, input);
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

    requestSteering(input: RequestSteeringInput): RequestSteeringResult {
      return requestSteering(database, input);
    },

    pollQueuedSteering(input: PollQueuedSteeringInput): PollQueuedSteeringResult {
      return pollQueuedSteering(database, input);
    },

    reportSteeringDelivery(input: ReportSteeringDeliveryInput): ReportSteeringDeliveryResult {
      return reportSteeringDelivery(database, input);
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
          return { ok: true, event, artifacts: [] };
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
        const artifacts = uniqueStrings(input.urlCandidates ?? extractUrls(input.text)).map((url) =>
          ensureArtifact(database, {
            projectId: input.projectId,
            taskId: current.task_id,
            sessionId: input.sessionId,
            kind: "final_response_url",
            uri: url,
            title: "Final response URL",
            metadata: { source: "final_response" },
          }).artifact,
        );

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: current.task_id,
          sessionId: input.sessionId,
          type: "session.final_response.recorded",
          payload: { sessionId: input.sessionId, artifactIds: artifacts.map((artifact) => artifact.id) },
        });
        return { ok: true, event, artifacts } as const;
      });
    },

    recordDocumentArtifact(input: RecordDocumentArtifactInput): RecordDocumentArtifactResult {
      if (!isAllowedBridgeDocumentPath(input.path)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `document path is outside allowed bridge roots: ${input.path}` },
        };
      }

      const session = database
        .query<{ id: string; status: string }, [string, string, string]>(
          "SELECT id, status FROM sessions WHERE project_id = ? AND task_id = ? AND id = ?",
        )
        .get(input.projectId, input.taskId, input.sessionId);
      if (!session) {
        return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      }
      if (!isActiveSessionStatus(session.status)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `document registration requires active session; got ${session.status}` },
        };
      }

      return transaction(database, () => {
        const artifactResult = ensureArtifact(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          kind: "document",
          uri: input.path,
          title: input.title ?? input.path.split("/").pop() ?? input.path,
          metadata: {
            contentType: input.contentType ?? null,
            sizeBytes: input.sizeBytes ?? null,
          },
        });
        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: artifactResult.created ? "artifact.document.registered" : "artifact.document.idempotent",
          payload: { artifactId: artifactResult.artifact.id, path: input.path },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, artifactId: artifactResult.artifact.id, type: event.type },
        });

        return {
          ok: true,
          artifact: artifactResult.artifact,
          event,
          outbox,
          idempotent: !artifactResult.created,
        } as const;
      });
    },

    readBridgeSessionCallbackConfig(input: ReadBridgeSessionCallbackConfigInput): ReadBridgeSessionCallbackConfigResult {
      const row = database
        .query<
          {
            project_id: string;
            task_id: string;
            id: string;
            bridge_callback_base_url: string | null;
            bridge_session_token_header: string | null;
            bridge_session_token: string | null;
          },
          [string, string, string]
        >(
          "SELECT project_id, task_id, id, bridge_callback_base_url, bridge_session_token_header, bridge_session_token FROM sessions WHERE project_id = ? AND task_id = ? AND id = ?",
        )
        .get(input.projectId, input.taskId, input.sessionId);

      if (!row) {
        return { ok: false, error: { code: "not_found", message: `bridge session not found: ${input.sessionId}` } };
      }

      if (!row.bridge_callback_base_url || !row.bridge_session_token_header || !row.bridge_session_token) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `bridge session callback token is not configured: ${input.sessionId}` },
        };
      }

      return {
        ok: true,
        bridge: {
          projectId: row.project_id,
          taskId: row.task_id,
          sessionId: row.id,
          callbackBaseUrl: row.bridge_callback_base_url,
          sessionToken: {
            headerName: row.bridge_session_token_header,
            token: row.bridge_session_token,
          },
        },
      };
    },

    recordSessionOutput(input: RecordSessionOutputInput): RecordSessionOutputResult {
      const current = database
        .query<{ id: string; project_id: string; task_id: string; status: string }, [string, string, string]>(
          "SELECT id, project_id, task_id, status FROM sessions WHERE project_id = ? AND task_id = ? AND id = ?",
        )
        .get(input.projectId, input.taskId, input.sessionId);

      if (!current) {
        return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      }

      if (!isActiveSessionStatus(current.status)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `output requires active session; got ${current.status}` },
        };
      }
      if (hasOutputSequence(database, input)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `duplicate output callback for ${input.stream} sequence ${input.sequence}` },
        };
      }

      return transaction(database, () => {
        const output = upsertLogStream(database, input);
        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: "session.output",
          payload: {
            sessionId: input.sessionId,
            taskId: input.taskId,
            stream: input.stream,
            sequence: input.sequence,
            byteOffset: input.byteOffset,
            text: input.text,
            observedAt: input.observedAt ?? null,
          },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, sessionId: input.sessionId, type: event.type },
        });

        return { ok: true, output, event, outbox } as const;
      });
    },

    completeSession(input: CompleteSessionInput): SessionTerminalResult {
      const current = readSessionForTerminalCallback(database, input);
      if (!current) return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      if (current.status === "succeeded" && current.task_status === "completed") {
        return appendTerminalIdempotentEvent(database, input, current, "session.completed.idempotent");
      }
      if (current.status !== "running") {
        return {
          ok: false,
          error: { code: "invalid_state", message: `completion requires running session; got ${current.status}` },
        };
      }

      return transaction(database, () => {
        database
          .query("UPDATE sessions SET status = 'succeeded', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
          .run(input.projectId, input.sessionId);
        database
          .query("UPDATE tasks SET status = 'completed', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
          .run(input.projectId, input.taskId);

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: "session.completed",
          payload: { sessionId: input.sessionId, taskId: input.taskId, observedAt: input.observedAt ?? null, metadata: input.metadata ?? {} },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, sessionId: input.sessionId, type: event.type },
        });

        return {
          ok: true,
          idempotent: false,
          session: { id: input.sessionId, projectId: input.projectId, taskId: input.taskId, status: "succeeded" },
          task: { id: input.taskId, projectId: input.projectId, status: "completed" },
          event,
          outbox,
        } as const;
      });
    },

    failSession(input: FailSessionInput): SessionTerminalResult {
      const current = readSessionForTerminalCallback(database, input);
      if (!current) return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      if (current.status === "failed") {
        return appendTerminalIdempotentEvent(database, input, current, "session.failed.idempotent");
      }
      if (!isActiveSessionStatus(current.status)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `failure requires active session; got ${current.status}` },
        };
      }

      const taskStatus = current.status === "starting" ? "blocked" : "failed";
      return transaction(database, () => {
        database
          .query("UPDATE sessions SET status = 'failed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
          .run(input.projectId, input.sessionId);
        database
          .query("UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
          .run(taskStatus, input.projectId, input.taskId);

        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: "session.failed",
          payload: {
            sessionId: input.sessionId,
            taskId: input.taskId,
            errorMessage: input.errorMessage,
            observedAt: input.observedAt ?? null,
            metadata: input.metadata ?? {},
          },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, sessionId: input.sessionId, type: event.type },
        });

        return {
          ok: true,
          idempotent: false,
          session: { id: input.sessionId, projectId: input.projectId, taskId: input.taskId, status: "failed" },
          task: { id: input.taskId, projectId: input.projectId, status: taskStatus },
          event,
          outbox,
        } as const;
      });
    },

    cleanupSession(input: CleanupSessionInput): SessionCleanupResult {
      const current = readSessionForTerminalCallback(database, input);
      if (!current) return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
      if (!["succeeded", "failed", "canceled"].includes(current.status)) {
        return {
          ok: false,
          error: { code: "invalid_state", message: `cleanup requires terminal session; got ${current.status}` },
        };
      }

      const existing = database
        .query<{ id: string }, [string, string]>(
          "SELECT id FROM events WHERE project_id = ? AND session_id = ? AND type = 'session.cleanup' LIMIT 1",
        )
        .get(input.projectId, input.sessionId);

      return transaction(database, () => {
        const event = appendEvent(database, {
          projectId: input.projectId,
          taskId: input.taskId,
          sessionId: input.sessionId,
          type: existing ? "session.cleanup.idempotent" : "session.cleanup",
          payload: { sessionId: input.sessionId, taskId: input.taskId, reason: input.reason ?? null, observedAt: input.observedAt ?? null, metadata: input.metadata ?? {} },
        });
        const outbox = enqueueOutbox(database, {
          projectId: input.projectId,
          eventId: event.id,
          routingKey: projectRoutingKey(input.projectId, "events"),
          payload: { eventId: event.id, sessionId: input.sessionId, type: event.type },
        });

        return { ok: true, idempotent: Boolean(existing), event, outbox } as const;
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

function upsertLogStream(database: WebSandboxSqliteDatabase, input: RecordSessionOutputInput): SessionOutputRecord {
  const existing = database
    .query<
      { id: string; byte_offset: number; line_count: number },
      [string, string, string, string]
    >(
      "SELECT id, byte_offset, line_count FROM log_streams WHERE project_id = ? AND task_id = ? AND session_id = ? AND kind = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(input.projectId, input.taskId, input.sessionId, input.stream);
  const byteOffset = Math.max(existing?.byte_offset ?? 0, input.byteOffset + byteLength(input.text));
  const lineCount = (existing?.line_count ?? 0) + countLines(input.text);
  const id = existing?.id ?? createId("log_stream");

  if (existing) {
    database
      .query(
        "UPDATE log_streams SET byte_offset = ?, line_count = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .run(byteOffset, lineCount, id);
  } else {
    database
      .query(
        "INSERT INTO log_streams (id, project_id, task_id, session_id, kind, byte_offset, line_count) VALUES (?, ?, ?, ?, ?, ?, ?)",
      )
      .run(id, input.projectId, input.taskId, input.sessionId, input.stream, byteOffset, lineCount);
  }

  return {
    id,
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    stream: input.stream,
    byteOffset,
    lineCount,
  };
}

function hasOutputSequence(database: WebSandboxSqliteDatabase, input: RecordSessionOutputInput): boolean {
  const rows = database
    .query<{ payload_json: string }, [string, string, string]>(
      "SELECT payload_json FROM events WHERE project_id = ? AND session_id = ? AND task_id = ? AND type = 'session.output'",
    )
    .all(input.projectId, input.sessionId, input.taskId);

  return rows.some((row) => {
    const payload = parseJsonObject(row.payload_json);

    return payload.stream === input.stream && payload.sequence === input.sequence;
  });
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split("\n").length - (value.endsWith("\n") ? 1 : 0);
}

function ensureArtifact(
  database: WebSandboxSqliteDatabase,
  input: {
    readonly projectId: string;
    readonly taskId: string | null;
    readonly sessionId: string | null;
    readonly kind: "final_response_url" | "document";
    readonly uri: string;
    readonly title: string | null;
    readonly metadata: Readonly<Record<string, unknown>>;
  },
): { readonly artifact: ArtifactRecord; readonly created: boolean } {
  const existing = database
    .query<
      { id: string; project_id: string; task_id: string | null; session_id: string | null; kind: "final_response_url" | "document"; uri: string; title: string | null },
      [string, string | null, string | null, string, string]
    >(
      "SELECT id, project_id, task_id, session_id, kind, uri, title FROM artifacts WHERE project_id = ? AND task_id IS ? AND session_id IS ? AND kind = ? AND uri = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(input.projectId, input.taskId, input.sessionId, input.kind, input.uri);

  if (existing) {
    return {
      created: false,
      artifact: {
        id: existing.id,
        projectId: existing.project_id,
        taskId: existing.task_id,
        sessionId: existing.session_id,
        kind: existing.kind,
        uri: existing.uri,
        title: existing.title,
      },
    };
  }

  const artifact: ArtifactRecord = {
    id: createId("artifact"),
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    kind: input.kind,
    uri: input.uri,
    title: input.title,
  };
  database
    .query(
      "INSERT INTO artifacts (id, project_id, task_id, session_id, kind, uri, title, metadata_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    )
    .run(
      artifact.id,
      artifact.projectId,
      artifact.taskId,
      artifact.sessionId,
      artifact.kind,
      artifact.uri,
      artifact.title,
      JSON.stringify(input.metadata),
    );

  return { artifact, created: true };
}

function isAllowedBridgeDocumentPath(path: string): boolean {
  if (path.startsWith("/") || path.includes("\\") || path.split("/").includes("..")) return false;
  return path.startsWith("agent-docs/") || path.startsWith("shared-docs/");
}

function extractUrls(text: string): readonly string[] {
  return text.match(/https?:\/\/[^\s<>"')\]]+/g)?.map((url) => url.replace(/[.,;:!?]+$/, "")) ?? [];
}

function uniqueStrings(values: readonly string[]): readonly string[] {
  return Array.from(new Set(values));
}

type TerminalSessionState = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly task_status: string;
};

function readSessionForTerminalCallback(
  database: WebSandboxSqliteDatabase,
  input: { readonly projectId: string; readonly taskId: string; readonly sessionId: string },
): TerminalSessionState | null {
  return database
    .query<TerminalSessionState, [string, string, string]>(
      `
        SELECT
          s.id,
          s.project_id,
          s.task_id,
          s.status,
          t.status AS task_status
        FROM sessions s
        JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
        WHERE s.project_id = ? AND s.task_id = ? AND s.id = ?
      `,
    )
    .get(input.projectId, input.taskId, input.sessionId) ?? null;
}

function appendTerminalIdempotentEvent(
  database: WebSandboxSqliteDatabase,
  input: CompleteSessionInput,
  current: TerminalSessionState,
  type: "session.completed.idempotent" | "session.failed.idempotent",
): SessionTerminalResult {
  return transaction(database, () => {
    const event = appendEvent(database, {
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      type,
      payload: { sessionId: input.sessionId, taskId: input.taskId },
    });
    const outbox = enqueueOutbox(database, {
      projectId: input.projectId,
      eventId: event.id,
      routingKey: projectRoutingKey(input.projectId, "events"),
      payload: { eventId: event.id, sessionId: input.sessionId, type: event.type },
    });

    return {
      ok: true,
      idempotent: true,
      session: {
        id: input.sessionId,
        projectId: input.projectId,
        taskId: input.taskId,
        status: current.status === "succeeded" ? "succeeded" : "failed",
      },
      task: {
        id: input.taskId,
        projectId: input.projectId,
        status:
          current.task_status === "completed" || current.task_status === "failed" || current.task_status === "blocked"
            ? current.task_status
            : "failed",
      },
      event,
      outbox,
    } as const;
  });
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

function updateTaskStatus(
  database: WebSandboxSqliteDatabase,
  input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly targetStatus: "queued" | "blocked" | "completed" | "failed";
    readonly eventType: string;
    readonly idempotentEventType: string;
    readonly allowedCurrentStatuses: readonly string[];
    readonly idempotentCurrentStatus: string;
  },
): TaskMutationResult {
  return transaction(database, () => {
    const current = readTaskState(database, input.projectId, input.taskId);
    if (!current) {
      return { ok: false, error: { code: "not_found", message: `task not found: ${input.taskId}` } } as const;
    }

    const idempotent = current.status === input.idempotentCurrentStatus;
    if (!idempotent && !input.allowedCurrentStatuses.includes(current.status)) {
      return {
        ok: false,
        error: { code: "invalid_state", message: `${input.eventType} requires ${input.allowedCurrentStatuses.join(" or ")} task; got ${current.status}` },
      } as const;
    }

    if (!idempotent) {
      database
        .query("UPDATE tasks SET status = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
        .run(input.targetStatus, input.projectId, input.taskId);
    }

    const event = appendEvent(database, {
      projectId: input.projectId,
      taskId: input.taskId,
      type: idempotent ? input.idempotentEventType : input.eventType,
      payload: { taskId: input.taskId, status: input.targetStatus },
    });
    const outbox = enqueueOutbox(database, {
      projectId: input.projectId,
      eventId: event.id,
      routingKey: projectRoutingKey(input.projectId, "events"),
      payload: { eventId: event.id, taskId: input.taskId, type: event.type },
    });
    const task = readPublicTaskDetail(database, input.projectId, input.taskId);
    if (!task) {
      return { ok: false, error: { code: "not_found", message: `task not found: ${input.taskId}` } } as const;
    }

    return { ok: true, task, event, outbox, idempotent } as const;
  });
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

function requestSteering(database: WebSandboxSqliteDatabase, input: RequestSteeringInput): RequestSteeringResult {
  const body = input.body.trim();
  if (!body) {
    return { ok: false, error: { code: "validation_error", message: "steering body is required" } };
  }

  const attachments = normalizeSteeringAttachments(input.projectId, input.attachments ?? []);
  if (!attachments.ok) return attachments;

  const admissibility = validateCommand(database, {
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    type: "steer",
    payload: {},
    requestedBy: input.requestedBy,
  });
  if (!admissibility.ok) return admissibility;

  return transaction(database, () => {
    const commandId = createId("command");
    const steeringId = input.id ?? createId("steer");
    const payload = { steeringMessageId: steeringId, body, attachments: attachments.attachments };

    database
      .query(
        "INSERT INTO orchestrator_commands (id, project_id, task_id, session_id, type, payload_json, requested_by) VALUES (?, ?, ?, ?, 'steer', ?, ?)",
      )
      .run(commandId, input.projectId, input.taskId, input.sessionId, JSON.stringify(payload), input.requestedBy ?? null);
    database
      .query("INSERT INTO steering_messages (id, project_id, task_id, session_id, command_id, body) VALUES (?, ?, ?, ?, ?, ?)")
      .run(steeringId, input.projectId, input.taskId, input.sessionId, commandId, body);

    const event = appendEvent(database, {
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      commandId,
      type: "steering.queued",
      payload: { steeringMessageId: steeringId, commandId, attachmentCount: attachments.attachments.length },
    });
    const outbox = enqueueOutbox(database, {
      projectId: input.projectId,
      eventId: event.id,
      routingKey: projectRoutingKey(input.projectId, "control"),
      payload: { eventId: event.id, commandId, steeringMessageId: steeringId, type: event.type },
    });
    const steering = readSteeringMessage(database, input.projectId, steeringId);

    if (!steering) {
      throw new Error(`queued steering disappeared: ${steeringId}`);
    }

    return {
      ok: true,
      steering,
      command: {
        id: commandId,
        projectId: input.projectId,
        taskId: input.taskId,
        sessionId: input.sessionId,
        type: "steer",
      },
      event,
      outbox,
    } as const;
  });
}

function pollQueuedSteering(database: WebSandboxSqliteDatabase, input: PollQueuedSteeringInput): PollQueuedSteeringResult {
  const session = database
    .query<{ task_id: string }, [string, string]>("SELECT task_id FROM sessions WHERE project_id = ? AND id = ?")
    .get(input.projectId, input.sessionId);
  if (!session || session.task_id !== input.taskId) {
    return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } };
  }

  const rows = database
    .query<
      {
        id: string;
        body: string;
        command_id: string | null;
        payload_json: string | null;
      },
      [string, string, string]
    >(
      `
        SELECT s.id, s.body, s.command_id, c.payload_json
        FROM steering_messages s
        LEFT JOIN orchestrator_commands c ON c.project_id = s.project_id AND c.id = s.command_id
        WHERE s.project_id = ? AND s.task_id = ? AND s.session_id = ? AND s.status = 'queued'
        ORDER BY s.created_at ASC, s.rowid ASC, s.id ASC
      `,
    )
    .all(input.projectId, input.taskId, input.sessionId);

  for (const row of rows) {
    if (row.command_id) {
      database
        .query(
          "UPDATE orchestrator_commands SET status = 'running', claimed_at = COALESCE(claimed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')) WHERE project_id = ? AND id = ? AND status = 'queued'",
        )
        .run(input.projectId, row.command_id);
    }
  }

  return {
    ok: true,
    messages: rows.map((row) => ({
      id: row.id,
      body: row.body,
      commandId: row.command_id,
      attachments: readAttachmentsFromCommandPayload(row.payload_json),
    })),
  };
}

function reportSteeringDelivery(database: WebSandboxSqliteDatabase, input: ReportSteeringDeliveryInput): ReportSteeringDeliveryResult {
  const current = readSteeringMessage(database, input.projectId, input.steeringMessageId);
  if (!current || current.taskId !== input.taskId || current.sessionId !== input.sessionId) {
    return { ok: false, error: { code: "not_found", message: `steering message not found: ${input.steeringMessageId}` } };
  }

  if (current.status !== "queued" && current.status !== input.status) {
    return {
      ok: false,
      error: { code: "invalid_state", message: `cannot report ${input.status} steering from ${current.status}` },
    };
  }

  return transaction(database, () => {
    const idempotent = current.status === input.status;
    const errorMessage = input.status === "failed" ? input.errorMessage?.trim() || "steering delivery failed" : null;

    if (!idempotent) {
      database
        .query(
          "UPDATE steering_messages SET status = ?, error_message = ?, delivered_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?",
        )
        .run(input.status, errorMessage, input.projectId, input.steeringMessageId);

      if (current.commandId) {
        database
          .query(
            "UPDATE orchestrator_commands SET status = ?, error_message = ?, completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ? AND status IN ('queued', 'running')",
          )
          .run(input.status === "delivered" ? "succeeded" : "failed", errorMessage, input.projectId, current.commandId);
      }
    }

    const eventType = input.status === "delivered" ? "steering.delivered" : "steering.failed";
    const event = appendEvent(database, {
      projectId: input.projectId,
      taskId: input.taskId,
      sessionId: input.sessionId,
      commandId: current.commandId,
      type: idempotent ? `${eventType}.idempotent` : eventType,
      payload: { steeringMessageId: input.steeringMessageId, errorMessage },
    });
    const outbox = enqueueOutbox(database, {
      projectId: input.projectId,
      eventId: event.id,
      routingKey: projectRoutingKey(input.projectId, "events"),
      payload: { eventId: event.id, steeringMessageId: input.steeringMessageId, type: event.type },
    });
    const steering = readSteeringMessage(database, input.projectId, input.steeringMessageId);

    if (!steering) {
      throw new Error(`reported steering disappeared: ${input.steeringMessageId}`);
    }

    return { ok: true, steering, event, outbox, idempotent } as const;
  });
}

function normalizeSteeringAttachments(
  projectId: string,
  attachments: readonly SteeringAttachmentReference[],
):
  | { readonly ok: true; readonly attachments: readonly SteeringAttachmentReference[] }
  | { readonly ok: false; readonly error: { readonly code: "validation_error"; readonly message: string } } {
  const normalized: SteeringAttachmentReference[] = [];

  for (const attachment of attachments) {
    const key = attachment.key?.trim();
    if (!key) {
      return { ok: false, error: { code: "validation_error", message: "attachment key is required" } };
    }
    if (!key.startsWith(`projects/${projectId}/`)) {
      return { ok: false, error: { code: "validation_error", message: "attachment key is outside project scope" } };
    }

    normalized.push({
      key,
      bucket: attachment.bucket?.trim() || null,
      fileName: attachment.fileName?.trim() || null,
      contentType: attachment.contentType?.trim() || null,
    });
  }

  return { ok: true, attachments: normalized };
}

function readAttachmentsFromCommandPayload(payloadJson: string | null): readonly SteeringAttachmentReference[] {
  if (!payloadJson) return [];
  const payload = parseJsonObject(payloadJson);
  const attachments = payload.attachments;
  if (!Array.isArray(attachments)) return [];

  return attachments.filter(isSteeringAttachmentReference);
}

function isSteeringAttachmentReference(value: unknown): value is SteeringAttachmentReference {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly key?: unknown };

  return typeof candidate.key === "string";
}

function readSteeringMessage(database: WebSandboxSqliteDatabase, projectId: string, steeringMessageId: string): SteeringMessageRecord | null {
  const row = database
    .query<
      {
        id: string;
        project_id: string;
        task_id: string;
        session_id: string;
        command_id: string | null;
        body: string;
        status: "queued" | "delivered" | "failed" | "canceled";
        error_message: string | null;
        created_at: string;
        delivered_at: string | null;
      },
      [string, string]
    >(
      "SELECT id, project_id, task_id, session_id, command_id, body, status, error_message, created_at, delivered_at FROM steering_messages WHERE project_id = ? AND id = ?",
    )
    .get(projectId, steeringMessageId);

  return row
    ? {
        id: row.id,
        projectId: row.project_id,
        taskId: row.task_id,
        sessionId: row.session_id,
        commandId: row.command_id,
        body: row.body,
        status: row.status,
        errorMessage: row.error_message,
        createdAt: row.created_at,
        deliveredAt: row.delivered_at,
      }
    : null;
}

function reportCommandTransition(
  database: WebSandboxSqliteDatabase,
  input: CommandReportInput,
  targetStatus: "running" | "succeeded" | "failed",
): CommandReportResult {
  return transaction(database, () => {
    const current = readCommandState(database, input.projectId, input.commandId);
    const errorMessage = targetStatus === "failed" ? input.errorMessage?.trim() || "command failed without details" : null;

    if (!current) {
      return { ok: false, error: { code: "not_found", message: `command not found: ${input.commandId}` } } as const;
    }

    if (current.status === targetStatus) {
      if (targetStatus === "failed" && current.error_message !== errorMessage) {
        return {
          ok: false,
          error: { code: "conflict", message: `command ${input.commandId} is already failed with different error details` },
        } as const;
      }

      if (targetStatus === "running" && !hasCommandReportEvent(database, input.projectId, input.commandId, "command.started")) {
        const { event, outbox } = appendCommandReportEvent(database, current, targetStatus, current.error_message);
        return {
          ok: true,
          idempotent: false,
          command: commandReportRecord(current, targetStatus, current.error_message),
          event,
          outbox,
        } as const;
      }

      return {
        ok: true,
        idempotent: true,
        command: commandReportRecord(current, targetStatus, current.error_message),
      } as const;
    }

    if (["succeeded", "failed", "canceled"].includes(current.status)) {
      return {
        ok: false,
        error: { code: "conflict", message: `command ${input.commandId} is already ${current.status}` },
      } as const;
    }

    if (targetStatus !== "running" && current.status !== "running") {
      return {
        ok: false,
        error: { code: "invalid_state", message: `${targetStatus} report requires running command; got ${current.status}` },
      } as const;
    }

    const completedSql = targetStatus === "running" ? "completed_at = NULL" : "completed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')";
    database
      .query(
        `UPDATE orchestrator_commands SET status = ?, error_message = ?, claimed_at = COALESCE(claimed_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ${completedSql} WHERE project_id = ? AND id = ?`,
      )
      .run(targetStatus, errorMessage, input.projectId, input.commandId);

    const updated = readCommandState(database, input.projectId, input.commandId);
    if (!updated) throw new Error(`reported command disappeared: ${input.commandId}`);

    const { event, outbox } = appendCommandReportEvent(database, updated, targetStatus, errorMessage);

    return {
      ok: true,
      idempotent: false,
      command: commandReportRecord(updated, targetStatus, errorMessage),
      event,
      outbox,
    } as const;
  });
}

function appendCommandReportEvent(
  database: WebSandboxSqliteDatabase,
  command: {
    readonly id: string;
    readonly project_id: string;
    readonly task_id: string | null;
    readonly session_id: string | null;
    readonly type: CommandType;
  },
  targetStatus: "running" | "succeeded" | "failed",
  errorMessage: string | null,
): { readonly event: EventRecord; readonly outbox: OutboxRecord } {
  const eventType = targetStatus === "running" ? "command.started" : `command.${targetStatus}`;
  const event = appendEvent(database, {
    projectId: command.project_id,
    taskId: command.task_id,
    sessionId: command.session_id,
    commandId: command.id,
    type: eventType,
    payload: { commandId: command.id, type: command.type, errorMessage },
  });
  const outbox = enqueueOutbox(database, {
    projectId: command.project_id,
    eventId: event.id,
    routingKey: projectRoutingKey(command.project_id, "control"),
    payload: { eventId: event.id, commandId: command.id, type: event.type },
  });

  return { event, outbox };
}

function hasCommandReportEvent(database: WebSandboxSqliteDatabase, projectId: string, commandId: string, type: string): boolean {
  const row = database
    .query<{ id: string }, [string, string, string]>(
      "SELECT id FROM events WHERE project_id = ? AND command_id = ? AND type = ? LIMIT 1",
    )
    .get(projectId, commandId, type);

  return Boolean(row);
}

function readCommandState(
  database: WebSandboxSqliteDatabase,
  projectId: string,
  commandId: string,
): {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly type: CommandType;
  readonly status: string;
  readonly error_message: string | null;
} | null {
  return database
    .query<
      {
        id: string;
        project_id: string;
        task_id: string | null;
        session_id: string | null;
        type: CommandType;
        status: string;
        error_message: string | null;
      },
      [string, string]
    >(
      "SELECT id, project_id, task_id, session_id, type, status, error_message FROM orchestrator_commands WHERE project_id = ? AND id = ?",
    )
    .get(projectId, commandId);
}

function reportStartupSucceeded(database: WebSandboxSqliteDatabase, input: StartupReportInput): StartupReportResult {
  return transaction(database, () => {
    const current = readStartupSessionState(database, input.projectId, input.sessionId);
    const runtimeSessionId = input.runtimeSessionId?.trim() || null;

    if (!current) {
      return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } } as const;
    }

    if (current.status === "running") {
      if (runtimeSessionId && current.runtime_session_id && current.runtime_session_id !== runtimeSessionId) {
        return {
          ok: false,
          error: { code: "conflict", message: `session ${input.sessionId} already has a different runtime session id` },
        } as const;
      }

      return {
        ok: true,
        idempotent: true,
        session: startupSessionRecord(current, "running"),
        task: startupTaskRecord(current, "running"),
      } as const;
    }

    if (current.status !== "starting") {
      return {
        ok: false,
        error: { code: "invalid_state", message: `startup success requires starting session; got ${current.status}` },
      } as const;
    }

    const nextRuntimeSessionId = runtimeSessionId ?? current.runtime_session_id;
    database
      .query(
        "UPDATE sessions SET status = 'running', runtime_session_id = ?, started_at = COALESCE(started_at, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), ended_at = NULL WHERE project_id = ? AND id = ?",
      )
      .run(nextRuntimeSessionId, input.projectId, input.sessionId);
    database
      .query("UPDATE tasks SET status = 'running', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
      .run(current.project_id, current.task_id);

    const updated = readStartupSessionState(database, input.projectId, input.sessionId);
    if (!updated) throw new Error(`reported startup session disappeared: ${input.sessionId}`);

    const { event, outbox } = appendStartupReportEvent(database, updated, "session.startup_succeeded", {
      runtimeSessionId: nextRuntimeSessionId,
    });

    return {
      ok: true,
      idempotent: false,
      session: startupSessionRecord(updated, "running"),
      task: startupTaskRecord(updated, "running"),
      event,
      outbox,
    } as const;
  });
}

function reportStartupFailed(database: WebSandboxSqliteDatabase, input: StartupReportInput): StartupReportResult {
  return transaction(database, () => {
    const current = readStartupSessionState(database, input.projectId, input.sessionId);
    const errorMessage = input.errorMessage?.trim() || "startup failed without details";

    if (!current) {
      return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } } as const;
    }

    if (current.status === "failed") {
      const existingMessage = readStartupFailureMessage(database, input.projectId, input.sessionId);
      if (existingMessage && existingMessage !== errorMessage) {
        return {
          ok: false,
          error: { code: "conflict", message: `session ${input.sessionId} already failed with different startup details` },
        } as const;
      }

      return {
        ok: true,
        idempotent: true,
        session: startupSessionRecord(current, "failed"),
        task: startupTaskRecord(current, "blocked"),
      } as const;
    }

    if (current.status !== "starting") {
      return {
        ok: false,
        error: { code: "invalid_state", message: `startup failure requires starting session; got ${current.status}` },
      } as const;
    }

    database
      .query("UPDATE sessions SET status = 'failed', ended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
      .run(input.projectId, input.sessionId);
    database
      .query("UPDATE tasks SET status = 'blocked', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE project_id = ? AND id = ?")
      .run(current.project_id, current.task_id);

    const updated = readStartupSessionState(database, input.projectId, input.sessionId);
    if (!updated) throw new Error(`reported startup session disappeared: ${input.sessionId}`);

    const { event, outbox } = appendStartupReportEvent(database, updated, "session.startup_failed", { errorMessage });

    return {
      ok: true,
      idempotent: false,
      session: startupSessionRecord(updated, "failed"),
      task: startupTaskRecord(updated, "blocked"),
      event,
      outbox,
    } as const;
  });
}

function appendStartupReportEvent(
  database: WebSandboxSqliteDatabase,
  session: StartupSessionState,
  type: "session.startup_succeeded" | "session.startup_failed",
  extraPayload: Readonly<Record<string, unknown>>,
): { readonly event: EventRecord; readonly outbox: OutboxRecord } {
  const event = appendEvent(database, {
    projectId: session.project_id,
    taskId: session.task_id,
    sessionId: session.id,
    type,
    payload: { sessionId: session.id, taskId: session.task_id, ...extraPayload },
  });
  const outbox = enqueueOutbox(database, {
    projectId: session.project_id,
    eventId: event.id,
    routingKey: projectRoutingKey(session.project_id, "control"),
    payload: { eventId: event.id, sessionId: session.id, type: event.type },
  });

  return { event, outbox };
}

type StartupSessionState = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly runtime_session_id: string | null;
  readonly task_status: string;
};

function readStartupSessionState(database: WebSandboxSqliteDatabase, projectId: string, sessionId: string): StartupSessionState | null {
  return database
    .query<StartupSessionState, [string, string]>(
      `
        SELECT s.id, s.project_id, s.task_id, s.status, s.runtime_session_id, t.status AS task_status
        FROM sessions s
        JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
        WHERE s.project_id = ? AND s.id = ?
      `,
    )
    .get(projectId, sessionId);
}

function readStartupFailureMessage(database: WebSandboxSqliteDatabase, projectId: string, sessionId: string): string | null {
  const row = database
    .query<{ payload_json: string }, [string, string]>(
      `
        SELECT payload_json
        FROM events
        WHERE project_id = ? AND session_id = ? AND type = 'session.startup_failed'
        ORDER BY created_at DESC, rowid DESC
        LIMIT 1
      `,
    )
    .get(projectId, sessionId);

  if (!row) return null;
  const payload = parseJsonObject(row.payload_json);
  return typeof payload.errorMessage === "string" ? payload.errorMessage : null;
}

function startupSessionRecord(session: StartupSessionState, status: "running" | "failed"): StartupReportSessionRecord {
  return {
    id: session.id,
    projectId: session.project_id,
    taskId: session.task_id,
    status,
    runtimeSessionId: session.runtime_session_id,
  };
}

function startupTaskRecord(session: StartupSessionState, status: "running" | "blocked"): StartupReportTaskRecord {
  return {
    id: session.task_id,
    projectId: session.project_id,
    status,
  };
}

function reportSessionHeartbeat(database: WebSandboxSqliteDatabase, input: SessionHeartbeatInput): SessionHeartbeatResult {
  return transaction(database, () => {
    const current = readHeartbeatSessionState(database, input.projectId, input.sessionId);
    const observedAt = input.observedAt?.trim() || readDatabaseTimestamp(database);

    if (!current) {
      return { ok: false, error: { code: "not_found", message: `session not found: ${input.sessionId}` } } as const;
    }
    if (!isActiveSessionStatus(current.status)) {
      return {
        ok: false,
        error: { code: "invalid_state", message: `heartbeat requires active session; got ${current.status}` },
      } as const;
    }
    if (input.observedAt?.trim() && current.heartbeat_status === "fresh" && current.last_heartbeat_at === observedAt) {
      return {
        ok: false,
        error: { code: "invalid_state", message: `duplicate heartbeat callback for ${input.sessionId}` },
      } as const;
    }

    database
      .query(
        "UPDATE sessions SET last_heartbeat_at = ?, heartbeat_status = 'fresh', stale_at = NULL, lost_at = NULL WHERE project_id = ? AND id = ?",
      )
      .run(observedAt, input.projectId, input.sessionId);

    const updated = readHeartbeatSessionState(database, input.projectId, input.sessionId);
    if (!updated || !isActiveSessionStatus(updated.status)) {
      throw new Error(`reported heartbeat session disappeared: ${input.sessionId}`);
    }

    const event = appendEvent(database, {
      projectId: updated.project_id,
      taskId: updated.task_id,
      sessionId: updated.id,
      type: "session.heartbeat",
      payload: { sessionId: updated.id, taskId: updated.task_id, observedAt },
    });
    const outbox = enqueueOutbox(database, {
      projectId: updated.project_id,
      eventId: event.id,
      routingKey: projectRoutingKey(updated.project_id, "events"),
      payload: { eventId: event.id, sessionId: updated.id, type: event.type },
    });

    return {
      ok: true,
      session: heartbeatSessionRecord(updated),
      event,
      outbox,
    } as const;
  });
}

function reconcileLostSessions(database: WebSandboxSqliteDatabase, input: HeartbeatReconcileInput): HeartbeatReconcileResult {
  const now = input.now?.trim() || readDatabaseTimestamp(database);
  const projectId = input.projectId?.trim() || null;
  const staleBefore = input.staleBefore.trim();
  const lostBefore = input.lostBefore.trim();

  return transaction(database, () => {
    const events: EventRecord[] = [];
    const outboxRows: OutboxRecord[] = [];
    const lost = selectLostHeartbeatCandidates(database, projectId, lostBefore).map((candidate) => {
      database
        .query(
          "UPDATE sessions SET status = 'failed', heartbeat_status = 'lost', stale_at = COALESCE(stale_at, ?), lost_at = ?, ended_at = COALESCE(ended_at, ?) WHERE project_id = ? AND id = ? AND status IN ('starting', 'running') AND heartbeat_status != 'lost'",
        )
        .run(now, now, now, candidate.project_id, candidate.id);
      database
        .query("UPDATE tasks SET status = 'blocked', updated_at = ? WHERE project_id = ? AND id = ? AND status = 'running'")
        .run(now, candidate.project_id, candidate.task_id);

      const { event, outbox } = appendHeartbeatReconcileEvent(database, candidate, "session.lost", {
        reason: "heartbeat_lost",
        lastHeartbeatAt: candidate.last_heartbeat_at,
        heartbeatBasisAt: candidate.heartbeat_basis_at,
        lostBefore,
        markedAt: now,
      });
      events.push(event);
      outboxRows.push(outbox);

      return reconciledHeartbeatSessionRecord(candidate, "failed", "lost");
    });

    const stale = selectStaleHeartbeatCandidates(database, projectId, staleBefore, lostBefore).map((candidate) => {
      database
        .query(
          "UPDATE sessions SET heartbeat_status = 'stale', stale_at = COALESCE(stale_at, ?) WHERE project_id = ? AND id = ? AND status IN ('starting', 'running') AND heartbeat_status = 'fresh'",
        )
        .run(now, candidate.project_id, candidate.id);

      const { event, outbox } = appendHeartbeatReconcileEvent(database, candidate, "session.stale", {
        lastHeartbeatAt: candidate.last_heartbeat_at,
        heartbeatBasisAt: candidate.heartbeat_basis_at,
        staleBefore,
        markedAt: now,
      });
      events.push(event);
      outboxRows.push(outbox);

      return reconciledHeartbeatSessionRecord(candidate, candidate.status, "stale");
    });

    return { ok: true, stale, lost, events, outbox: outboxRows } as const;
  });
}

type HeartbeatSessionState = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly status: string;
  readonly heartbeat_status: string;
  readonly last_heartbeat_at: string | null;
  readonly stale_at: string | null;
  readonly lost_at: string | null;
};

type HeartbeatReconcileCandidate = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly status: "starting" | "running";
  readonly heartbeat_status: string;
  readonly last_heartbeat_at: string | null;
  readonly heartbeat_basis_at: string;
};

function readHeartbeatSessionState(database: WebSandboxSqliteDatabase, projectId: string, sessionId: string): HeartbeatSessionState | null {
  return database
    .query<HeartbeatSessionState, [string, string]>(
      "SELECT id, project_id, task_id, status, heartbeat_status, last_heartbeat_at, stale_at, lost_at FROM sessions WHERE project_id = ? AND id = ?",
    )
    .get(projectId, sessionId);
}

function selectLostHeartbeatCandidates(
  database: WebSandboxSqliteDatabase,
  projectId: string | null,
  lostBefore: string,
): HeartbeatReconcileCandidate[] {
  return database
    .query<HeartbeatReconcileCandidate, [string | null, string | null, string]>(
      `
        SELECT
          s.id,
          s.project_id,
          s.task_id,
          s.status,
          s.heartbeat_status,
          s.last_heartbeat_at,
          COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) AS heartbeat_basis_at
        FROM sessions s
        JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
        WHERE s.status IN ('starting', 'running')
          AND s.heartbeat_status != 'lost'
          AND (? IS NULL OR s.project_id = ?)
          AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) <= ?
        ORDER BY heartbeat_basis_at ASC, s.created_at ASC, s.id ASC
      `,
    )
    .all(projectId, projectId, lostBefore);
}

function selectStaleHeartbeatCandidates(
  database: WebSandboxSqliteDatabase,
  projectId: string | null,
  staleBefore: string,
  lostBefore: string,
): HeartbeatReconcileCandidate[] {
  return database
    .query<HeartbeatReconcileCandidate, [string | null, string | null, string, string]>(
      `
        SELECT
          s.id,
          s.project_id,
          s.task_id,
          s.status,
          s.heartbeat_status,
          s.last_heartbeat_at,
          COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) AS heartbeat_basis_at
        FROM sessions s
        JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
        WHERE s.status IN ('starting', 'running')
          AND s.heartbeat_status = 'fresh'
          AND (? IS NULL OR s.project_id = ?)
          AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) <= ?
          AND COALESCE(s.last_heartbeat_at, s.started_at, s.created_at) > ?
        ORDER BY heartbeat_basis_at ASC, s.created_at ASC, s.id ASC
      `,
    )
    .all(projectId, projectId, staleBefore, lostBefore);
}

function appendHeartbeatReconcileEvent(
  database: WebSandboxSqliteDatabase,
  session: HeartbeatReconcileCandidate,
  type: "session.stale" | "session.lost",
  extraPayload: Readonly<Record<string, unknown>>,
): { readonly event: EventRecord; readonly outbox: OutboxRecord } {
  const event = appendEvent(database, {
    projectId: session.project_id,
    taskId: session.task_id,
    sessionId: session.id,
    type,
    payload: { sessionId: session.id, taskId: session.task_id, ...extraPayload },
  });
  const outbox = enqueueOutbox(database, {
    projectId: session.project_id,
    eventId: event.id,
    routingKey: projectRoutingKey(session.project_id, "control"),
    payload: { eventId: event.id, sessionId: session.id, type: event.type },
  });

  return { event, outbox };
}

function heartbeatSessionRecord(session: HeartbeatSessionState): SessionHeartbeatRecord {
  if (!isActiveSessionStatus(session.status) || session.last_heartbeat_at === null) {
    throw new Error(`session heartbeat record is not active/fresh: ${session.id}`);
  }

  return {
    id: session.id,
    projectId: session.project_id,
    taskId: session.task_id,
    status: session.status,
    heartbeatStatus: "fresh",
    lastHeartbeatAt: session.last_heartbeat_at,
    staleAt: null,
    lostAt: null,
  };
}

function reconciledHeartbeatSessionRecord(
  session: HeartbeatReconcileCandidate,
  status: "starting" | "running" | "failed",
  heartbeatStatus: "stale" | "lost",
): ReconciledHeartbeatSessionRecord {
  return {
    id: session.id,
    projectId: session.project_id,
    taskId: session.task_id,
    status,
    heartbeatStatus,
    lastHeartbeatAt: session.last_heartbeat_at,
    heartbeatBasisAt: session.heartbeat_basis_at,
  };
}

function isActiveSessionStatus(status: string): status is "starting" | "running" {
  return status === "starting" || status === "running";
}

function readDatabaseTimestamp(database: WebSandboxSqliteDatabase): string {
  const row = database.query<{ now: string }, []>("SELECT strftime('%Y-%m-%dT%H:%M:%fZ', 'now') AS now").get();
  if (!row) throw new Error("failed to read database timestamp");
  return row.now;
}

function commandReportRecord(
  row: {
    readonly id: string;
    readonly project_id: string;
    readonly task_id: string | null;
    readonly session_id: string | null;
    readonly type: CommandType;
  },
  status: "running" | "succeeded" | "failed",
  errorMessage: string | null,
): CommandReportRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    type: row.type,
    status,
    errorMessage,
  };
}

type PublicProjectRow = {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly description: string | null;
  readonly status: string;
  readonly created_at: string;
  readonly updated_at: string;
};

type PublicTaskRow = {
  readonly id: string;
  readonly project_id: string;
  readonly display_id: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly runtime_source_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
};

type PublicSessionRow = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string;
  readonly attempt_number: number;
  readonly status: string;
  readonly runtime_provider: string | null;
  readonly runtime_session_id: string | null;
  readonly created_at: string;
  readonly started_at: string | null;
  readonly ended_at: string | null;
  readonly final_response_recorded_at: string | null;
  readonly last_heartbeat_at: string | null;
  readonly heartbeat_status: string;
  readonly stale_at: string | null;
  readonly lost_at: string | null;
};

type PublicCommandRow = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly type: CommandType;
  readonly status: string;
  readonly payload_json: string;
  readonly error_message: string | null;
  readonly requested_by: string | null;
  readonly created_at: string;
  readonly claimed_at: string | null;
  readonly completed_at: string | null;
};

type PublicArtifactRow = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly kind: string;
  readonly uri: string;
  readonly title: string | null;
  readonly metadata_json: string;
  readonly created_at: string;
};

type PublicEventRow = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly command_id: string | null;
  readonly type: string;
  readonly payload_json: string;
  readonly created_at: string;
};

type PublicLogStreamRow = {
  readonly id: string;
  readonly project_id: string;
  readonly task_id: string | null;
  readonly session_id: string | null;
  readonly kind: string;
  readonly byte_offset: number;
  readonly line_count: number;
  readonly created_at: string;
  readonly updated_at: string;
};

function listPublicProjects(database: WebSandboxSqliteDatabase): readonly PublicProjectSummary[] {
  const rows = database
    .query<PublicProjectRow, []>(
      "SELECT id, slug, name, description, status, created_at, updated_at FROM projects ORDER BY created_at ASC, id ASC",
    )
    .all();
  const countRows = database
    .query<{ project_id: string; status: "queued" | "running" | "blocked" | "completed" | "failed"; count: number }, []>(
      "SELECT project_id, status, COUNT(*) AS count FROM tasks GROUP BY project_id, status",
    )
    .all();
  const countsByProject = new Map<string, Record<"queued" | "running" | "blocked" | "completed" | "failed", number>>();

  for (const countRow of countRows) {
    const counts = countsByProject.get(countRow.project_id) ?? emptyTaskCounts();
    counts[countRow.status] = countRow.count;
    countsByProject.set(countRow.project_id, counts);
  }

  return rows.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    status: row.status,
    taskCounts: countsByProject.get(row.id) ?? emptyTaskCounts(),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));
}

function listPublicTaskSummaries(database: WebSandboxSqliteDatabase, projectId: string): readonly PublicTaskSummary[] {
  return database
    .query<PublicTaskRow, [string]>(
      `
        SELECT id, project_id, display_id, title, description, status, priority, runtime_source_json, created_at, updated_at
        FROM tasks
        WHERE project_id = ?
        ORDER BY priority DESC, display_id ASC, created_at ASC, id ASC
      `,
    )
    .all(projectId)
    .map((row) => publicTaskSummary(database, row));
}

function readPublicTaskDetail(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): PublicTaskDetail | null {
  const row = database
    .query<PublicTaskRow, [string, string]>(
      `
        SELECT id, project_id, display_id, title, description, status, priority, runtime_source_json, created_at, updated_at
        FROM tasks
        WHERE project_id = ? AND id = ?
      `,
    )
    .get(projectId, taskId);

  if (!row) return null;

  return {
    ...publicTaskSummary(database, row),
    sessions: listPublicSessionsForTask(database, projectId, taskId),
    artifacts: listPublicArtifactsForTask(database, projectId, taskId),
    events: listPublicEventsForTask(database, projectId, taskId),
    logStreams: listPublicLogStreamsForTask(database, projectId, taskId),
  };
}

function publicTaskSummary(database: WebSandboxSqliteDatabase, row: PublicTaskRow): PublicTaskSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    displayId: row.display_id,
    title: row.title,
    description: row.description,
    status: row.status,
    priority: row.priority,
    runtimeSource: readRuntimeSourceJson(row.runtime_source_json),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    latestSession: readLatestPublicSessionForTask(database, row.project_id, row.id),
    pendingCommands: listPendingPublicCommandsForTask(database, row.project_id, row.id),
  };
}

function readLatestPublicSessionForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): PublicSessionSummary | null {
  const row = database
    .query<PublicSessionRow, [string, string]>(
      `
        SELECT id, project_id, task_id, attempt_number, status, runtime_provider, runtime_session_id, created_at, started_at, ended_at,
          final_response_recorded_at, last_heartbeat_at, heartbeat_status, stale_at, lost_at
        FROM sessions
        WHERE project_id = ? AND task_id = ?
        ORDER BY attempt_number DESC, created_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(projectId, taskId);

  return row ? publicSessionSummary(row) : null;
}

function listPublicSessionsForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): readonly PublicSessionSummary[] {
  return database
    .query<PublicSessionRow, [string, string]>(
      `
        SELECT id, project_id, task_id, attempt_number, status, runtime_provider, runtime_session_id, created_at, started_at, ended_at,
          final_response_recorded_at, last_heartbeat_at, heartbeat_status, stale_at, lost_at
        FROM sessions
        WHERE project_id = ? AND task_id = ?
        ORDER BY attempt_number ASC, created_at ASC, id ASC
      `,
    )
    .all(projectId, taskId)
    .map(publicSessionSummary);
}

function listPendingPublicCommandsForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): readonly PublicCommandSummary[] {
  return database
    .query<PublicCommandRow, [string, string, string, string]>(
      `
        SELECT c.id, c.project_id, c.task_id, c.session_id, c.type, c.status, c.payload_json, c.error_message, c.requested_by,
          c.created_at, c.claimed_at, c.completed_at
        FROM orchestrator_commands c
        WHERE c.project_id = ?
          AND c.status IN ('queued', 'running')
          AND (
            c.task_id = ?
            OR c.session_id IN (SELECT id FROM sessions WHERE project_id = ? AND task_id = ?)
          )
        ORDER BY c.created_at ASC, c.rowid ASC, c.id ASC
      `,
    )
    .all(projectId, taskId, projectId, taskId)
    .map(publicCommandSummary);
}

function listPublicArtifactsForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): readonly PublicArtifactSummary[] {
  return database
    .query<PublicArtifactRow, [string, string, string, string]>(
      `
        SELECT id, project_id, task_id, session_id, kind, uri, title, metadata_json, created_at
        FROM artifacts
        WHERE project_id = ?
          AND (
            task_id = ?
            OR session_id IN (SELECT id FROM sessions WHERE project_id = ? AND task_id = ?)
          )
        ORDER BY created_at ASC, rowid ASC, id ASC
      `,
    )
    .all(projectId, taskId, projectId, taskId)
    .map(publicArtifactSummary);
}

function listPublicEventsForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): readonly PublicEventSummary[] {
  return listPublicEvents(database, { projectId, taskId });
}

function listPublicEvents(database: WebSandboxSqliteDatabase, input: ListPublicEventsInput): readonly PublicEventSummary[] {
  const afterRowid = readReplayAfterRowid(database, input.projectId, input.lastEventId);
  const taskId = input.taskId?.trim() || null;
  const sessionId = input.sessionId?.trim() || null;
  const dispatchOnly = input.dispatchOnly ? 1 : 0;

  return database
    .query<PublicEventRow, [string, number, string | null, string | null, string | null, string | null, string | null, number]>(
      `
        SELECT id, project_id, task_id, session_id, command_id, type, payload_json, created_at
        FROM events
        WHERE project_id = ?
          AND rowid > ?
          AND (
            ? IS NULL
            OR task_id = ?
            OR session_id IN (SELECT id FROM sessions WHERE project_id = events.project_id AND task_id = ?)
          )
          AND (? IS NULL OR session_id = ?)
          AND (? = 0 OR command_id IS NOT NULL OR type LIKE 'command.%' OR type = 'task.claimed')
        ORDER BY rowid ASC, id ASC
      `,
    )
    .all(input.projectId, afterRowid, taskId, taskId, taskId, sessionId, sessionId, dispatchOnly)
    .map(publicEventSummary);
}

function readReplayAfterRowid(database: WebSandboxSqliteDatabase, projectId: string, lastEventId: string | null | undefined): number {
  const eventId = lastEventId?.trim();
  if (!eventId) return 0;

  return (
    database
      .query<{ rowid: number }, [string, string]>("SELECT rowid FROM events WHERE project_id = ? AND id = ?")
      .get(projectId, eventId)?.rowid ?? 0
  );
}

function listPublicLogStreamsForTask(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): readonly PublicLogStreamSummary[] {
  return database
    .query<PublicLogStreamRow, [string, string, string, string]>(
      `
        SELECT id, project_id, task_id, session_id, kind, byte_offset, line_count, created_at, updated_at
        FROM log_streams
        WHERE project_id = ?
          AND (
            task_id = ?
            OR session_id IN (SELECT id FROM sessions WHERE project_id = ? AND task_id = ?)
          )
        ORDER BY created_at ASC, rowid ASC, id ASC
      `,
    )
    .all(projectId, taskId, projectId, taskId)
    .map(publicLogStreamSummary);
}

function publicSessionSummary(row: PublicSessionRow): PublicSessionSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    attemptNumber: row.attempt_number,
    status: row.status,
    runtimeProvider: row.runtime_provider,
    runtimeSessionId: row.runtime_session_id,
    createdAt: row.created_at,
    startedAt: row.started_at,
    endedAt: row.ended_at,
    finalResponseRecordedAt: row.final_response_recorded_at,
    lastHeartbeatAt: row.last_heartbeat_at,
    heartbeatStatus: row.heartbeat_status,
    staleAt: row.stale_at,
    lostAt: row.lost_at,
  };
}

function publicCommandSummary(row: PublicCommandRow): PublicCommandSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    payload: parsePublicJsonObject(row.payload_json),
    errorMessage: row.error_message,
    requestedBy: row.requested_by,
    createdAt: row.created_at,
    claimedAt: row.claimed_at,
    completedAt: row.completed_at,
  };
}

function publicArtifactSummary(row: PublicArtifactRow): PublicArtifactSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind,
    uri: row.uri,
    title: row.title,
    metadata: parsePublicJsonObject(row.metadata_json),
    createdAt: row.created_at,
  };
}

function publicEventSummary(row: PublicEventRow): PublicEventSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    commandId: row.command_id,
    type: row.type,
    payload: parsePublicJsonObject(row.payload_json),
    createdAt: row.created_at,
  };
}

function publicLogStreamSummary(row: PublicLogStreamRow): PublicLogStreamSummary {
  return {
    id: row.id,
    projectId: row.project_id,
    taskId: row.task_id,
    sessionId: row.session_id,
    kind: row.kind,
    byteOffset: row.byte_offset,
    lineCount: row.line_count,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function emptyTaskCounts(): Record<"queued" | "running" | "blocked" | "completed" | "failed", number> {
  return {
    queued: 0,
    running: 0,
    blocked: 0,
    completed: 0,
    failed: 0,
  };
}

function selectNextQueuedCommand(
  database: WebSandboxSqliteDatabase,
  projectId?: string,
): { readonly id: string; readonly project_id: string } | null {
  return database
    .query<{ id: string; project_id: string }, [string | null, string | null]>(
      `
        SELECT c.id, c.project_id
        FROM orchestrator_commands c
        JOIN projects p ON p.id = c.project_id
        WHERE c.status = 'queued'
          AND p.status = 'active'
          AND (? IS NULL OR c.project_id = ?)
        ORDER BY c.created_at ASC, c.rowid ASC, c.id ASC
        LIMIT 1
      `,
    )
    .get(projectId ?? null, projectId ?? null);
}

function selectNextEligibleTask(
  database: WebSandboxSqliteDatabase,
  projectId?: string,
): {
  readonly id: string;
  readonly project_id: string;
  readonly display_id: number;
  readonly title: string;
  readonly priority: number;
  readonly runtime_source_json: string | null;
} | null {
  const sql = `
    SELECT t.id, t.project_id, t.display_id, t.title, t.priority, t.runtime_source_json
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
    ORDER BY t.priority DESC, t.display_id ASC, t.created_at ASC, t.id ASC
    LIMIT 1
  `;

  return database
    .query<
      { id: string; project_id: string; display_id: number; title: string; priority: number; runtime_source_json: string | null },
      [string | null, string | null]
    >(sql)
    .get(projectId ?? null, projectId ?? null);
}

function normalizeTaskPriority(value: number | null | undefined): number {
  if (value === null || value === undefined) return 0;
  if (!Number.isInteger(value)) {
    throw new Error("task priority must be an integer");
  }
  return value;
}

function sanitizeTaskRuntimeSource(input: TaskRuntimeSourceMetadata | null | undefined): TaskRuntimeSourceMetadata | null {
  if (!input) return null;
  const repositoryUrl = input.repositoryUrl.trim();
  const baseRef = input.baseRef.trim();
  const taskBranchPrefix = input.taskBranchPrefix.trim();

  if (!/^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(repositoryUrl)) {
    throw new Error("task runtime source repositoryUrl must be an https GitHub repository URL");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(baseRef) || baseRef.includes("..")) {
    throw new Error("task runtime source baseRef is invalid");
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(taskBranchPrefix) || taskBranchPrefix.includes("..")) {
    throw new Error("task runtime source taskBranchPrefix is invalid");
  }

  const source = { repositoryUrl, baseRef, taskBranchPrefix };
  const serialized = JSON.stringify(source);
  if (/token|secret|password|github_pat_|ghp_/i.test(serialized)) {
    throw new Error("task runtime source must not contain secret values");
  }

  return source;
}

function readRuntimeSourceJson(value: string | null): TaskRuntimeSourceMetadata | null {
  if (!value) return null;
  return sanitizeTaskRuntimeSource(JSON.parse(value) as TaskRuntimeSourceMetadata);
}

function readTaskState(database: WebSandboxSqliteDatabase, projectId: string, taskId: string): { readonly status: string; readonly priority: number } | null {
  return database
    .query<{ status: string; priority: number }, [string, string]>("SELECT status, priority FROM tasks WHERE project_id = ? AND id = ?")
    .get(projectId, taskId);
}

function readSessionState(database: WebSandboxSqliteDatabase, projectId: string, sessionId: string): { readonly status: string } | null {
  return database
    .query<{ status: string }, [string, string]>("SELECT status FROM sessions WHERE project_id = ? AND id = ?")
    .get(projectId, sessionId);
}

function commandError(code: CommandAdmissibilityError["code"], message: string): { readonly ok: false; readonly error: CommandAdmissibilityError } {
  return { ok: false, error: { code, message } };
}

function parseJsonObject(value: string): Readonly<Record<string, unknown>> {
  const parsed: unknown = JSON.parse(value);
  return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

function parsePublicJsonObject(value: string): Readonly<Record<string, unknown>> {
  return redactPublicValue(parseJsonObject(value)) as Readonly<Record<string, unknown>>;
}

function redactPublicValue(value: unknown, key = ""): unknown {
  if (typeof value === "string") {
    if (isSensitivePublicKey(key) || isSensitivePublicString(value)) return "[REDACTED]";
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactPublicValue(item, key));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([entryKey, entryValue]) => [
        entryKey,
        redactPublicValue(entryValue, entryKey),
      ]),
    );
  }

  return value;
}

function isSensitivePublicKey(key: string): boolean {
  return /token|secret|password|credential/i.test(key);
}

function isSensitivePublicString(value: string): boolean {
  return (
    /github_pat_|ghp_|service-token|bridge-token|session-token|api[_-]?key|password|secret/i.test(value) ||
    /\.agent-pool\/data\/agent-pool\.db/i.test(value) ||
    /web-sandbox\.db/i.test(value)
  );
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

function bridgeCallbackConfig(input: {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly callbackBaseUrl?: string | null;
  readonly sessionTokenHeaderName?: string | null;
  readonly sessionToken?: string | null;
}): BridgeSessionCallbackConfig {
  return {
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    callbackBaseUrl: input.callbackBaseUrl?.trim() || DEFAULT_BRIDGE_CALLBACK_BASE_URL,
    sessionToken: {
      headerName: input.sessionTokenHeaderName?.trim().toLowerCase() || DEFAULT_BRIDGE_SESSION_TOKEN_HEADER,
      token: input.sessionToken?.trim() || createId("bridge_token"),
    },
  };
}

function createId(prefix: string): string {
  return `${prefix}_${globalThis.crypto.randomUUID()}`;
}
