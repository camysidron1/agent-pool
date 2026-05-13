export const PUBLIC_OPERATOR_ID_HEADER = "x-agent-pool-operator-id";

export type JsonRecord = Readonly<Record<string, unknown>>;

export type PublicApiClientOptions = {
  readonly baseUrl?: string;
  readonly operatorId: string;
  readonly fetchImpl?: typeof fetch;
};

export type PublicApiClient = ReturnType<typeof createPublicApiClient>;

export type PublicApiErrorBody = {
  readonly ok: false;
  readonly error: {
    readonly code: string;
    readonly message: string;
  };
};

export type PublicApiSuccess<T> = T & {
  readonly ok: true;
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

export type PublicRuntimeSource = {
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
};

export type PublicCommandSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly type: string;
  readonly status: string;
  readonly payload: JsonRecord;
  readonly errorMessage: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly claimedAt: string | null;
  readonly completedAt: string | null;
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
  readonly finalResponseText: string | null;
  readonly finalResponseMetadata: JsonRecord;
  readonly finalResponseRecordedAt: string | null;
  readonly lastHeartbeatAt: string | null;
  readonly heartbeatStatus: string;
  readonly staleAt: string | null;
  readonly lostAt: string | null;
};

export type PublicTaskSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly displayId: number;
  readonly title: string;
  readonly description: string | null;
  readonly status: string;
  readonly priority: number;
  readonly runtimeSource: PublicRuntimeSource | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly latestSession: PublicSessionSummary | null;
  readonly pendingCommands: readonly PublicCommandSummary[];
};

export type PublicEventSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly commandId: string | null;
  readonly type: string;
  readonly payload: JsonRecord;
  readonly createdAt: string;
};

export type PublicArtifactSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly kind: string;
  readonly uri: string;
  readonly title: string | null;
  readonly metadata: JsonRecord;
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

export type PublicNoteSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string | null;
  readonly authorId: string | null;
  readonly body: string;
  readonly createdAt: string;
  readonly updatedAt: string;
};

export type PublicPlannedUpload = {
  readonly adapter: string;
  readonly bucket: string;
  readonly key: string;
  readonly localPath: string | null;
  readonly method: string;
  readonly contentType: string | null;
  readonly expiresAt: string | null;
  readonly headers: JsonRecord;
  readonly fields: JsonRecord;
};

export type PublicUploadPlanInput = {
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly fileName: string;
  readonly contentType?: string | null;
};

export type PublicSteeringAttachmentReference = {
  readonly key: string;
  readonly bucket?: string | null;
  readonly fileName?: string | null;
  readonly contentType?: string | null;
};

export type PublicSteeringMessageSummary = {
  readonly id: string;
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly commandId: string;
  readonly body: string;
  readonly status: string;
  readonly errorMessage: string | null;
  readonly requestedBy: string | null;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
  readonly attachments: readonly PublicSteeringAttachmentReference[];
};

export type PublicTaskDetail = PublicTaskSummary & {
  readonly sessions: readonly PublicSessionSummary[];
  readonly artifacts: readonly PublicArtifactSummary[];
  readonly events: readonly PublicEventSummary[];
  readonly logStreams: readonly PublicLogStreamSummary[];
  readonly steeringMessages: readonly PublicSteeringMessageSummary[];
  readonly notes: readonly PublicNoteSummary[];
};

export type PublicCommandMutation = {
  readonly command: PublicCommandSummary;
  readonly event: PublicEventSummary;
  readonly outbox: unknown;
  readonly task: PublicTaskDetail | null;
  readonly pendingCommands: readonly PublicCommandSummary[];
};

export type PublicSteeringMutation = {
  readonly steering: PublicSteeringMessageSummary;
  readonly command: PublicCommandSummary;
  readonly event: PublicEventSummary;
  readonly outbox: unknown;
  readonly task: PublicTaskDetail | null;
  readonly pendingCommands: readonly PublicCommandSummary[];
};

export type PublicNoteMutation = {
  readonly note: PublicNoteSummary;
  readonly event: PublicEventSummary;
  readonly outbox: unknown;
  readonly task: PublicTaskDetail;
};

export class PublicApiError extends Error {
  readonly status: number;
  readonly code: string;

  constructor(status: number, code: string, message: string) {
    super(message);
    this.name = "PublicApiError";
    this.status = status;
    this.code = code;
  }
}

export function createPublicApiClient(options: PublicApiClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const fetchImpl = options.fetchImpl ?? fetch;
  const operatorId = options.operatorId.trim();

  async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("accept", "application/json");
    headers.set(PUBLIC_OPERATOR_ID_HEADER, operatorId);

    if (init.body && !headers.has("content-type")) {
      headers.set("content-type", "application/json");
    }

    const response = await fetchImpl(`${baseUrl}/api/public${path}`, {
      ...init,
      headers,
    });
    const body = await readJson(response);

    if (!response.ok || isPublicApiErrorBody(body)) {
      const error = isPublicApiErrorBody(body)
        ? body.error
        : { code: "http_error", message: `Request failed with status ${response.status}` };
      throw new PublicApiError(response.status, error.code, error.message);
    }

    return body as T;
  }

  return {
    me: () => request<PublicApiSuccess<{ readonly operator: unknown; readonly authMode: string }>>("/me"),
    listProjects: () => request<PublicApiSuccess<{ readonly projects: readonly PublicProjectSummary[] }>>("/projects"),
    listTasks: (projectId: string) =>
      request<PublicApiSuccess<{ readonly tasks: readonly PublicTaskSummary[] }>>(`/projects/${encodePath(projectId)}/tasks`),
    readTask: (projectId: string, taskId: string) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskDetail }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}`,
      ),
    planProjectUpload: (projectId: string, input: PublicUploadPlanInput) =>
      request<PublicApiSuccess<{ readonly upload: PublicPlannedUpload }>>(`/projects/${encodePath(projectId)}/uploads/plan`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    steerSession: (
      projectId: string,
      taskId: string,
      sessionId: string,
      input: { readonly body: string; readonly attachments?: readonly PublicSteeringAttachmentReference[] },
    ) =>
      request<PublicApiSuccess<PublicSteeringMutation>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/sessions/${encodePath(sessionId)}/steer`,
        { method: "POST", body: JSON.stringify(input) },
      ),
    interruptSession: (projectId: string, taskId: string, sessionId: string, payload: JsonRecord) =>
      request<PublicApiSuccess<PublicCommandMutation>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/sessions/${encodePath(sessionId)}/interrupt`,
        { method: "POST", body: JSON.stringify(payload) },
      ),
    createTaskNote: (projectId: string, taskId: string, input: { readonly body: string; readonly sessionId?: string | null }) =>
      request<PublicApiSuccess<PublicNoteMutation>>(`/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/notes`, {
        method: "POST",
        body: JSON.stringify(input),
      }),
    updateTaskNote: (projectId: string, taskId: string, noteId: string, input: { readonly body: string }) =>
      request<PublicApiSuccess<PublicNoteMutation>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/notes/${encodePath(noteId)}`,
        { method: "PATCH", body: JSON.stringify(input) },
      ),
    deleteTaskNote: (projectId: string, taskId: string, noteId: string) =>
      request<PublicApiSuccess<PublicNoteMutation>>(`/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/notes/${encodePath(noteId)}`, {
        method: "DELETE",
      }),
    updateTaskPriority: (projectId: string, taskId: string, priority: number) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskSummary; readonly pendingCommands: readonly PublicCommandSummary[] }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/priority`,
        { method: "POST", body: JSON.stringify({ priority }) },
      ),
    backlogTask: (projectId: string, taskId: string) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskSummary; readonly pendingCommands: readonly PublicCommandSummary[] }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/backlog`,
        { method: "POST" },
      ),
    unblockTask: (projectId: string, taskId: string) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskSummary; readonly pendingCommands: readonly PublicCommandSummary[] }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/unblock`,
        { method: "POST" },
      ),
    cancelTask: (projectId: string, taskId: string) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskSummary | null; readonly pendingCommands: readonly PublicCommandSummary[] }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/cancel`,
        { method: "POST" },
      ),
    retryTask: (projectId: string, taskId: string) =>
      request<PublicApiSuccess<{ readonly task: PublicTaskSummary | null; readonly pendingCommands: readonly PublicCommandSummary[] }>>(
        `/projects/${encodePath(projectId)}/tasks/${encodePath(taskId)}/retry`,
        { method: "POST" },
      ),
  };
}

export function normalizeBaseUrl(value: string | undefined): string {
  return value?.replace(/\/+$/, "") ?? "";
}

function encodePath(value: string): string {
  return encodeURIComponent(value);
}

async function readJson(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new PublicApiError(response.status, "invalid_json", "Public API returned invalid JSON");
  }
}

function isPublicApiErrorBody(value: unknown): value is PublicApiErrorBody {
  if (!value || typeof value !== "object") return false;
  const body = value as { readonly ok?: unknown; readonly error?: unknown };
  if (body.ok !== false || !body.error || typeof body.error !== "object") return false;
  const error = body.error as { readonly code?: unknown; readonly message?: unknown };

  return typeof error.code === "string" && typeof error.message === "string";
}
