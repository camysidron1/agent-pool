import { createServiceTokenHeaders } from "@agent-pool/auth";
import type { AppConfig } from "@agent-pool/config";

export type BackendInternalClientOptions = {
  readonly config: AppConfig;
  readonly fetch?: typeof fetch;
};

export type BackendHealthClientOptions = BackendInternalClientOptions;

export type BackendInternalHealthResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

export type BackendInternalHttpResult<TBody> =
  | { readonly ok: true; readonly status: number; readonly body: TBody }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

export type BackendEvent = {
  readonly id: string;
  readonly projectId: string;
  readonly type: string;
};

export type BackendOutbox = {
  readonly id: string;
  readonly projectId: string;
  readonly eventId: string | null;
  readonly routingKey: string;
};

export type ClaimNextTaskInput = {
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly runtimeProvider?: string;
};

export type BackendBridgeSessionConfig = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly callbackBaseUrl: string;
  readonly sessionToken: {
    readonly headerName: string;
    readonly token: string;
  };
};

export type BackendTaskRuntimeSourceMetadata = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
};

export type ClaimedTaskPayload = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly runtimeSource?: BackendTaskRuntimeSourceMetadata | null;
};

export type ClaimedTaskSession = Readonly<Record<string, unknown>> & {
  readonly id: string;
  readonly bridge: BackendBridgeSessionConfig;
};

export type ClaimNextTaskResponse =
  | {
      readonly ok: true;
      readonly claimed: true;
      readonly task: ClaimedTaskPayload;
      readonly session: ClaimedTaskSession;
      readonly event: BackendEvent;
      readonly outbox: BackendOutbox;
    }
  | { readonly ok: true; readonly claimed: false; readonly reason: "no_eligible_task" };

export type ClaimNextCommandInput = {
  readonly projectId?: string;
};

export type ClaimNextCommandResponse =
  | {
      readonly ok: true;
      readonly claimed: true;
      readonly command: Readonly<Record<string, unknown>>;
      readonly event: BackendEvent;
      readonly outbox: BackendOutbox;
    }
  | { readonly ok: true; readonly claimed: false; readonly reason: "no_queued_command" };

export type CommandReportInput = {
  readonly projectId: string;
  readonly commandId: string;
  readonly errorMessage?: string;
};

export type CommandReportResponse = {
  readonly ok: true;
  readonly idempotent: boolean;
  readonly command: Readonly<Record<string, unknown>>;
  readonly event: BackendEvent | null;
  readonly outbox: BackendOutbox | null;
};

export type StartupReportInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly runtimeSessionId?: string;
  readonly errorMessage?: string;
};

export type StartupReportResponse = {
  readonly ok: true;
  readonly idempotent: boolean;
  readonly session: Readonly<Record<string, unknown>>;
  readonly task: Readonly<Record<string, unknown>>;
  readonly event: BackendEvent | null;
  readonly outbox: BackendOutbox | null;
};

export type SessionHeartbeatInput = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly observedAt?: string;
};

export type SessionHeartbeatResponse = {
  readonly ok: true;
  readonly session: Readonly<Record<string, unknown>>;
  readonly event: BackendEvent;
  readonly outbox: BackendOutbox;
};

export type ReconcileInput = {
  readonly projectId?: string;
  readonly staleBefore: string;
  readonly lostBefore: string;
  readonly now?: string;
};

export type ReconcileResponse = {
  readonly ok: true;
  readonly stale: readonly Readonly<Record<string, unknown>>[];
  readonly lost: readonly Readonly<Record<string, unknown>>[];
  readonly events: readonly BackendEvent[];
  readonly outbox: readonly BackendOutbox[];
};

export type BackendInternalApiClient = {
  readonly checkHealth: () => Promise<BackendInternalHealthResult>;
  readonly claimNextTask: (input?: ClaimNextTaskInput) => Promise<BackendInternalHttpResult<ClaimNextTaskResponse>>;
  readonly claimNextCommand: (input?: ClaimNextCommandInput) => Promise<BackendInternalHttpResult<ClaimNextCommandResponse>>;
  readonly reportCommandStarted: (input: CommandReportInput) => Promise<BackendInternalHttpResult<CommandReportResponse>>;
  readonly reportCommandSucceeded: (input: CommandReportInput) => Promise<BackendInternalHttpResult<CommandReportResponse>>;
  readonly reportCommandFailed: (input: CommandReportInput) => Promise<BackendInternalHttpResult<CommandReportResponse>>;
  readonly reportStartupSucceeded: (input: StartupReportInput) => Promise<BackendInternalHttpResult<StartupReportResponse>>;
  readonly reportStartupFailed: (input: StartupReportInput) => Promise<BackendInternalHttpResult<StartupReportResponse>>;
  readonly reportSessionHeartbeat: (input: SessionHeartbeatInput) => Promise<BackendInternalHttpResult<SessionHeartbeatResponse>>;
  readonly reconcile: (input: ReconcileInput) => Promise<BackendInternalHttpResult<ReconcileResponse>>;
};

export function createBackendInternalApiClient(options: BackendInternalClientOptions): BackendInternalApiClient {
  return {
    checkHealth: () => checkBackendInternalHealth(options),
    claimNextTask: (input: ClaimNextTaskInput = {}) =>
      postJson(options, "/internal/orchestrator/tasks/claim-next", input),
    claimNextCommand: (input: ClaimNextCommandInput = {}) =>
      postJson(options, "/internal/orchestrator/commands/claim-next", input),
    reportCommandStarted: (input: CommandReportInput) =>
      postJson(options, `/internal/orchestrator/commands/${encodeURIComponent(input.commandId)}/started`, commandReportBody(input)),
    reportCommandSucceeded: (input: CommandReportInput) =>
      postJson(options, `/internal/orchestrator/commands/${encodeURIComponent(input.commandId)}/succeeded`, commandReportBody(input)),
    reportCommandFailed: (input: CommandReportInput) =>
      postJson(options, `/internal/orchestrator/commands/${encodeURIComponent(input.commandId)}/failed`, commandReportBody(input)),
    reportStartupSucceeded: (input: StartupReportInput) =>
      postJson(
        options,
        `/internal/orchestrator/sessions/${encodeURIComponent(input.sessionId)}/startup-succeeded`,
        startupReportBody(input),
      ),
    reportStartupFailed: (input: StartupReportInput) =>
      postJson(
        options,
        `/internal/orchestrator/sessions/${encodeURIComponent(input.sessionId)}/startup-failed`,
        startupReportBody(input),
      ),
    reportSessionHeartbeat: (input: SessionHeartbeatInput) =>
      postJson(
        options,
        `/internal/orchestrator/sessions/${encodeURIComponent(input.sessionId)}/heartbeat`,
        sessionHeartbeatBody(input),
      ),
    reconcile: (input: ReconcileInput) => postJson(options, "/internal/orchestrator/reconcile", input),
  };
}

export async function checkBackendInternalHealth(
  options: BackendHealthClientOptions,
): Promise<BackendInternalHealthResult> {
  const response = await fetchJson(options, "/internal/health", {
    headers: createServiceTokenHeaders(options.config.serviceToken),
  });
  const body = response.body;

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body,
  };
}

async function postJson<TBody>(
  options: BackendInternalClientOptions,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<BackendInternalHttpResult<TBody>> {
  const response = await fetchJson(options, path, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(options.config.serviceToken),
    },
    body: JSON.stringify(body),
  });

  return {
    ok: response.status >= 200 && response.status < 300,
    status: response.status,
    body: response.body,
  } as BackendInternalHttpResult<TBody>;
}

async function fetchJson(
  options: BackendInternalClientOptions,
  path: string,
  init: RequestInit,
): Promise<{ readonly status: number; readonly body: unknown }> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${options.config.orchestrator.backendInternalUrl}${path}`, init);
  const body = await response.json().catch(() => null);

  return {
    status: response.status,
    body,
  };
}

function commandReportBody(input: CommandReportInput): Readonly<Record<string, unknown>> {
  return {
    projectId: input.projectId,
    errorMessage: input.errorMessage,
  };
}

function startupReportBody(input: StartupReportInput): Readonly<Record<string, unknown>> {
  return {
    projectId: input.projectId,
    runtimeSessionId: input.runtimeSessionId,
    errorMessage: input.errorMessage,
  };
}

function sessionHeartbeatBody(input: SessionHeartbeatInput): Readonly<Record<string, unknown>> {
  return {
    projectId: input.projectId,
    observedAt: input.observedAt,
  };
}
