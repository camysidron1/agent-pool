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
  readonly runtimeSource?: SmokeRuntimeSourceInput | null;
};

export type SmokeRuntimeSourceInput = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
  readonly allowedEgressDomains?: readonly string[];
  readonly commandProfile?: string | null;
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
  readonly diagnostics: SmokeStatusDiagnostics;
};

export type SmokeDiagnosticStageId =
  | "readiness"
  | "seed"
  | "claim"
  | "sandbox-create"
  | "bootstrap-clone"
  | "install"
  | "codex"
  | "pr"
  | "cleanup"
  | "snapshot";

export type SmokeDiagnosticStageStatus = "pending" | "running" | "passed" | "failed" | "risk";

export type SmokeStatusDiagnostics = {
  readonly currentStage: SmokeDiagnosticStageId;
  readonly failedStage: SmokeDiagnosticStageId | null;
  readonly stages: readonly SmokeStageDiagnosticRecord[];
  readonly latestSession: SessionStatusRecord | null;
  readonly runtimeSandbox: RuntimeSandboxStatusRecord | null;
  readonly latestSnapshot: SnapshotStatusRecord | null;
  readonly securityEvents: readonly SecurityEventSummaryRecord[];
  readonly logSnippets: readonly SmokeLogSnippetRecord[];
};

type SmokeStageDiagnosticRecord = {
  readonly id: SmokeDiagnosticStageId;
  readonly label: string;
  readonly status: SmokeDiagnosticStageStatus;
  readonly detail: string;
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

type RuntimeSandboxStatusRecord = {
  readonly id: string;
  readonly provider: string;
  readonly providerSandboxId: string;
  readonly status: string;
  readonly snapshotStatus: string;
  readonly snapshotEligibilityStatus: string;
  readonly snapshotRiskReasons: readonly string[];
  readonly cleanupAttempts: number;
  readonly snapshotAttempts: number;
  readonly terminalAt: string | null;
  readonly cleanupCompletedAt: string | null;
  readonly snapshotCompletedAt: string | null;
  readonly lastErrorMessage: string | null;
};

type SnapshotStatusRecord = {
  readonly id: string;
  readonly provider: string | null;
  readonly status: string | null;
  readonly expiresAt: string | null;
  readonly deletedAt: string | null;
  readonly usageCount: number;
  readonly lastUsedAt: string | null;
  readonly errorMessage: string | null;
};

type SecurityEventSummaryRecord = {
  readonly securityKind: string;
  readonly count: number;
  readonly allowed: number;
  readonly denied: number;
  readonly lastStage: SmokeDiagnosticStageId | null;
  readonly lastReason: string | null;
  readonly lastHost: string | null;
  readonly lastCommand: string | null;
  readonly lastPolicy: string | null;
};

type SmokeLogSnippetRecord = {
  readonly stream: string;
  readonly sequence: number | null;
  readonly observedAt: string | null;
  readonly text: string;
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

type OutputEventRecord = {
  readonly stream: string;
  readonly sequence: number | null;
  readonly observedAt: string | null;
  readonly text: string;
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
      runtimeSource: options.runtimeSource ?? undefined,
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
  const outputEvents = readOutputEvents(options.database, ids.projectId, ids.taskId);
  const runtimeSandbox = readLatestRuntimeSandbox(options.database, ids.projectId, ids.taskId);
  const latestSnapshot = readLatestSnapshot(options.database, ids.projectId, ids.taskId);
  const securityEvents = summarizeSecurityEvents(outputEvents);
  const artifacts = readArtifacts(options.database, ids.projectId, ids.taskId);
  const sessionCounts = countBy(sessions, "status");
  const heartbeatCounts = countBy(sessions, "heartbeatStatus");
  const finalResponseSessions = sessions.filter((session) => session.finalResponseRecordedAt !== null).length;
  const finalResponseArtifacts = artifacts.filter((artifact) => artifact.kind === "final_response_url").length;
  const completionEvents = (eventCounts["session.completed"] ?? 0) + (eventCounts["session.completed.idempotent"] ?? 0);
  const failureEvents = (eventCounts["session.failed"] ?? 0) + (eventCounts["session.failed.idempotent"] ?? 0);
  const cleanupEvents = (eventCounts["session.cleanup"] ?? 0) + (eventCounts["session.cleanup.idempotent"] ?? 0);
  const diagnostics = buildSmokeDiagnostics({
    project,
    task,
    sessions,
    runtimeSandbox,
    latestSnapshot,
    securityEvents,
    logSnippets: outputEvents.slice(-12).map(toLogSnippet),
    finalResponseRecorded: finalResponseSessions > 0,
    finalResponseArtifacts,
    completionEvents,
    failureEvents,
    cleanupEvents,
  });

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
    diagnostics,
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

function readOutputEvents(database: ApiDatabaseConnection, projectId: string, taskId: string): readonly OutputEventRecord[] {
  return database.sqlite
    .query<{ payload_json: string }, [string, string]>(
      `
        SELECT payload_json
        FROM events
        WHERE project_id = ? AND task_id = ? AND type = 'session.output'
        ORDER BY created_at ASC, rowid ASC
        LIMIT 200
      `,
    )
    .all(projectId, taskId)
    .map((row) => {
      const payload = readJsonObject(row.payload_json);
      return {
        stream: readString(payload.stream) ?? "unknown",
        sequence: typeof payload.sequence === "number" ? payload.sequence : null,
        observedAt: readString(payload.observedAt),
        text: redactDiagnosticText(readString(payload.text) ?? ""),
      };
    });
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

function readLatestRuntimeSandbox(database: ApiDatabaseConnection, projectId: string, taskId: string): RuntimeSandboxStatusRecord | null {
  const row = database.sqlite
    .query<
      {
        id: string;
        provider: string;
        provider_sandbox_id: string;
        status: string;
        snapshot_status: string;
        snapshot_eligibility_status: string;
        snapshot_risk_reasons_json: string;
        cleanup_attempts: number;
        snapshot_attempts: number;
        terminal_at: string | null;
        cleanup_completed_at: string | null;
        snapshot_completed_at: string | null;
        last_error_message: string | null;
      },
      [string, string]
    >(
      `
        SELECT
          id,
          provider,
          provider_sandbox_id,
          status,
          snapshot_status,
          snapshot_eligibility_status,
          snapshot_risk_reasons_json,
          cleanup_attempts,
          snapshot_attempts,
          terminal_at,
          cleanup_completed_at,
          snapshot_completed_at,
          last_error_message
        FROM runtime_sandboxes
        WHERE project_id = ? AND task_id = ?
        ORDER BY created_at DESC, id DESC
        LIMIT 1
      `,
    )
    .get(projectId, taskId);

  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    providerSandboxId: row.provider_sandbox_id,
    status: row.status,
    snapshotStatus: row.snapshot_status,
    snapshotEligibilityStatus: row.snapshot_eligibility_status,
    snapshotRiskReasons: readStringArray(row.snapshot_risk_reasons_json),
    cleanupAttempts: row.cleanup_attempts,
    snapshotAttempts: row.snapshot_attempts,
    terminalAt: row.terminal_at,
    cleanupCompletedAt: row.cleanup_completed_at,
    snapshotCompletedAt: row.snapshot_completed_at,
    lastErrorMessage: row.last_error_message ? redactDiagnosticText(row.last_error_message) : null,
  };
}

function readLatestSnapshot(database: ApiDatabaseConnection, projectId: string, taskId: string): SnapshotStatusRecord | null {
  const row = database.sqlite
    .query<
      {
        id: string;
        provider: string | null;
        status: string | null;
        expires_at: string | null;
        deleted_at: string | null;
        usage_count: number;
        last_used_at: string | null;
        error_message: string | null;
      },
      [string, string]
    >(
      `
        SELECT
          ss.id,
          ss.provider,
          ss.status,
          ss.expires_at,
          ss.deleted_at,
          ss.usage_count,
          ss.last_used_at,
          ss.error_message
        FROM session_snapshots ss
        JOIN sessions s ON s.project_id = ss.project_id AND s.id = ss.session_id
        WHERE ss.project_id = ? AND s.task_id = ?
        ORDER BY ss.created_at DESC, ss.id DESC
        LIMIT 1
      `,
    )
    .get(projectId, taskId);

  if (!row) return null;
  return {
    id: row.id,
    provider: row.provider,
    status: row.status,
    expiresAt: row.expires_at,
    deletedAt: row.deleted_at,
    usageCount: row.usage_count,
    lastUsedAt: row.last_used_at,
    errorMessage: row.error_message ? redactDiagnosticText(row.error_message) : null,
  };
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

function buildSmokeDiagnostics(input: {
  readonly project: ProjectStatusRecord | null;
  readonly task: TaskStatusRecord | null;
  readonly sessions: readonly SessionStatusRecord[];
  readonly runtimeSandbox: RuntimeSandboxStatusRecord | null;
  readonly latestSnapshot: SnapshotStatusRecord | null;
  readonly securityEvents: readonly SecurityEventSummaryRecord[];
  readonly logSnippets: readonly SmokeLogSnippetRecord[];
  readonly finalResponseRecorded: boolean;
  readonly finalResponseArtifacts: number;
  readonly completionEvents: number;
  readonly failureEvents: number;
  readonly cleanupEvents: number;
}): SmokeStatusDiagnostics {
  const latestSession = input.sessions[0] ?? null;
  const taskSeeded = Boolean(input.project && input.task);
  const sessionClaimed = input.sessions.length > 0;
  const taskFailed = input.task?.status === "failed" || input.task?.status === "blocked";
  const sessionFailed = input.sessions.some((session) => session.status === "failed" || session.heartbeatStatus === "lost");
  const terminalFailure = taskFailed || sessionFailed || input.failureEvents > 0;
  const sandboxReady = Boolean(input.runtimeSandbox || latestSession?.runtimeSessionId);
  const bridgeOutputSeen = input.logSnippets.length > 0;
  const installStarted = hasSecurity(input.securityEvents, "dependency-install-started") || hasSecurity(input.securityEvents, "package-install");
  const installPassed = hasSecurity(input.securityEvents, "dependency-install-finished") || input.finalResponseRecorded || input.completionEvents > 0;
  const installFailed = hasSecurity(input.securityEvents, "dependency-install-failed");
  const commandDenied = hasDeniedSecurity(input.securityEvents, "command-policy");
  const codexSeen = hasSecurity(input.securityEvents, "codex-started") || hasSecurity(input.securityEvents, "command-policy") || hasSecurity(input.securityEvents, "postflight");
  const postflightSeen = hasSecurity(input.securityEvents, "postflight");
  const prObserved = input.finalResponseArtifacts > 0 || (postflightSeen && input.finalResponseRecorded);
  const cleanupFailed = input.runtimeSandbox?.status === "cleanup_failed";
  const cleanupPassed = input.cleanupEvents > 0 || input.runtimeSandbox?.status === "cleanup_succeeded";
  const snapshotRisk = input.runtimeSandbox?.snapshotEligibilityStatus === "risk";
  const snapshotFailed = input.runtimeSandbox?.snapshotStatus === "failed" || input.latestSnapshot?.status === "failed";
  const snapshotPassed =
    !input.runtimeSandbox ||
    input.runtimeSandbox.provider !== "e2b" ||
    input.runtimeSandbox.snapshotStatus === "not_required" ||
    input.runtimeSandbox.snapshotStatus === "succeeded" ||
    input.runtimeSandbox.snapshotStatus === "skipped" ||
    input.latestSnapshot?.status === "ready";

  const stages: SmokeStageDiagnosticRecord[] = [
    stage("readiness", "Readiness", "passed", "Smoke status endpoint is reachable."),
    stage(
      "seed",
      "Seed",
      taskSeeded ? "passed" : "pending",
      taskSeeded ? "Smoke project and task exist." : "Smoke fixture has not been seeded.",
    ),
    stage(
      "claim",
      "Queue claim",
      !taskSeeded ? "pending" : sessionClaimed ? "passed" : "running",
      sessionClaimed ? "A worker claimed the smoke task." : "Waiting for orchestrator task claim.",
    ),
    stage(
      "sandbox-create",
      "Sandbox create",
      !sessionClaimed ? "pending" : sandboxReady ? "passed" : terminalFailure ? "failed" : "running",
      sandboxReady ? "Provider startup reported a runtime sandbox." : "Waiting for provider sandbox startup.",
    ),
    stage(
      "bootstrap-clone",
      "Bootstrap clone",
      !sandboxReady ? "pending" : bridgeOutputSeen || installStarted || codexSeen || input.finalResponseRecorded ? "passed" : terminalFailure ? "failed" : "running",
      bridgeOutputSeen || installStarted || codexSeen || input.finalResponseRecorded
        ? "Bridge output has started after repository bootstrap."
        : "Waiting for repository bootstrap and bridge startup.",
    ),
    stage(
      "install",
      "Dependency install",
      installFailed ? "failed" : installPassed ? "passed" : installStarted ? "running" : !bridgeOutputSeen ? "pending" : "running",
      installFailed ? "Frozen dependency install failed." : installPassed ? "Dependency install completed or was not required for this runner." : "Waiting for frozen dependency install.",
    ),
    stage(
      "codex",
      "Codex run",
      commandDenied ? "failed" : input.finalResponseRecorded || input.completionEvents > 0 || postflightSeen ? "passed" : terminalFailure && installPassed ? "failed" : installPassed ? "running" : "pending",
      commandDenied ? "Codex attempted a denied command." : input.finalResponseRecorded || input.completionEvents > 0 || postflightSeen ? "Codex produced terminal output." : "Waiting for Codex execution.",
    ),
    stage(
      "pr",
      "Pull request",
      prObserved ? "passed" : terminalFailure && (postflightSeen || installPassed) ? "failed" : input.finalResponseRecorded ? "running" : "pending",
      prObserved ? "A final response or postflight PR signal was recorded." : "Waiting for PR evidence.",
    ),
    stage(
      "cleanup",
      "Cleanup",
      cleanupFailed ? "failed" : cleanupPassed ? "passed" : input.completionEvents > 0 || terminalFailure ? "running" : "pending",
      cleanupFailed ? "Provider cleanup failed." : cleanupPassed ? "Bridge cleanup callback or provider cleanup succeeded." : "Waiting for bridge/provider cleanup.",
    ),
    stage(
      "snapshot",
      "Snapshot",
      snapshotRisk ? "risk" : snapshotFailed ? "failed" : snapshotPassed && cleanupPassed ? "passed" : cleanupPassed && input.runtimeSandbox ? "running" : "pending",
      snapshotRisk
        ? `Snapshot skipped due to risk: ${input.runtimeSandbox?.snapshotRiskReasons.join(", ") || "unknown"}`
        : snapshotFailed
          ? "Snapshot creation failed."
          : snapshotPassed && cleanupPassed
            ? "Snapshot decision is complete."
            : "Waiting for snapshot decision.",
    ),
  ];

  const failedStage = stages.find((candidate) => candidate.status === "failed" || candidate.status === "risk")?.id ?? null;
  const currentStage = failedStage ?? stages.find((candidate) => candidate.status === "running" || candidate.status === "pending")?.id ?? "snapshot";

  return {
    currentStage,
    failedStage,
    stages,
    latestSession,
    runtimeSandbox: input.runtimeSandbox,
    latestSnapshot: input.latestSnapshot,
    securityEvents: input.securityEvents,
    logSnippets: input.logSnippets,
  };
}

function stage(
  id: SmokeDiagnosticStageId,
  label: string,
  status: SmokeDiagnosticStageStatus,
  detail: string,
): SmokeStageDiagnosticRecord {
  return { id, label, status, detail };
}

function summarizeSecurityEvents(outputEvents: readonly OutputEventRecord[]): readonly SecurityEventSummaryRecord[] {
  const summaries = new Map<string, SecurityEventSummaryRecord>();

  for (const output of outputEvents) {
    for (const line of output.text.split("\n")) {
      const parsed = readJsonObject(line);
      const type = readString(parsed.type);
      const securityKind = readString(parsed.securityKind);
      if (!securityKind || !type?.startsWith("security")) continue;
      const current = summaries.get(securityKind) ?? {
        securityKind,
        count: 0,
        allowed: 0,
        denied: 0,
        lastStage: null,
        lastReason: null,
        lastHost: null,
        lastCommand: null,
        lastPolicy: null,
      };
      const allowed = parsed.allowed === true;
      const denied = parsed.allowed === false;
      summaries.set(securityKind, {
        securityKind,
        count: current.count + 1,
        allowed: current.allowed + (allowed ? 1 : 0),
        denied: current.denied + (denied ? 1 : 0),
        lastStage: readStageId(parsed.stage) ?? current.lastStage,
        lastReason: readRedactedString(parsed.reason) ?? current.lastReason,
        lastHost: readRedactedString(parsed.host) ?? current.lastHost,
        lastCommand: readRedactedString(parsed.command) ?? current.lastCommand,
        lastPolicy: readRedactedString(parsed.policy) ?? current.lastPolicy,
      });
    }
  }

  return [...summaries.values()].sort((left, right) => left.securityKind.localeCompare(right.securityKind));
}

function hasSecurity(summaries: readonly SecurityEventSummaryRecord[], securityKind: string): boolean {
  return summaries.some((summary) => summary.securityKind === securityKind && summary.count > 0);
}

function hasDeniedSecurity(summaries: readonly SecurityEventSummaryRecord[], securityKind: string): boolean {
  return summaries.some((summary) => summary.securityKind === securityKind && summary.denied > 0);
}

function toLogSnippet(output: OutputEventRecord): SmokeLogSnippetRecord {
  return {
    stream: output.stream,
    sequence: output.sequence,
    observedAt: output.observedAt,
    text: truncate(redactDiagnosticText(output.text), 800),
  };
}

function readJsonObject(value: string): Readonly<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Readonly<Record<string, unknown>> : {};
  } catch {
    return {};
  }
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRedactedString(value: unknown): string | null {
  const string = readString(value);
  return string ? truncate(redactDiagnosticText(string), 500) : null;
}

function readStageId(value: unknown): SmokeDiagnosticStageId | null {
  const stageId = readString(value);
  return stageId && isSmokeDiagnosticStageId(stageId) ? stageId : null;
}

function isSmokeDiagnosticStageId(value: string): value is SmokeDiagnosticStageId {
  return [
    "readiness",
    "seed",
    "claim",
    "sandbox-create",
    "bootstrap-clone",
    "install",
    "codex",
    "pr",
    "cleanup",
    "snapshot",
  ].includes(value);
}

function readStringArray(value: string): readonly string[] {
  const parsed = readJsonObject(value);
  if (Array.isArray(parsed)) return parsed.filter((item): item is string => typeof item === "string").map(redactDiagnosticText);
  try {
    const array = JSON.parse(value);
    return Array.isArray(array) ? array.filter((item): item is string => typeof item === "string").map(redactDiagnosticText) : [];
  } catch {
    return [];
  }
}

function redactDiagnosticText(value: string): string {
  return value
    .replace(/~\/\.agent-pool\/data\/agent-pool\.db/g, "[REDACTED_DB_PATH]")
    .replace(/\/Users\/[^\s"']+\/\.agent-pool\/data\/agent-pool\.db/g, "[REDACTED_DB_PATH]")
    .replace(/\b(?:ghp|ghs|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_CODEX_KEY]")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/g, "$1[REDACTED]@")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|PROXY)[A-Z0-9_]*)=([^\s"']+)/gi, "$1=[REDACTED]");
}

function truncate(value: string, maxLength: number): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}...`;
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
