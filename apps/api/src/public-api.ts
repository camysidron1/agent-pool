import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import type { AppConfig, OperatorIdentity, RuntimeProviderName } from "@agent-pool/config";
import type {
  CanonicalStateServices,
  CreateProjectInput,
  CreateTaskInput,
  PublicTaskDetail,
  RequestCommandResult,
  TaskMutationResult,
  TaskRuntimeSourceMetadata,
} from "@agent-pool/db";
import type { StorageAdapter } from "@agent-pool/storage";

export type PublicApiOptions = {
  readonly config: AppConfig;
  readonly services?: PublicApiServices | null;
  readonly storage?: StorageAdapter | null;
};

export type PublicOperatorRequest = Request & {
  publicOperator?: OperatorIdentity;
};

const PUBLIC_OPERATOR_ID_HEADER = "x-agent-pool-operator-id";

type PublicApiServices = Pick<
  CanonicalStateServices,
  | "backlogTask"
  | "createProject"
  | "createTask"
  | "listProjectTasks"
  | "listProjects"
  | "readTaskDetail"
  | "requestCommand"
  | "unblockTask"
  | "updateTaskPriority"
> & {
  readonly createProjectWithQueues?: (input: CreateProjectInput) => {
    readonly project: unknown;
    readonly queues: unknown;
  };
};

export function registerPublicApiRoutes(app: Express, options: PublicApiOptions): void {
  const requirePublicOperator = createPublicOperatorMiddleware(options.config);

  app.get("/api/public/me", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    response.status(200).json({
      ok: true,
      operator: request.publicOperator,
      authMode: options.config.authMode,
    });
  });

  app.get("/api/public/projects", requirePublicOperator, (_request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    response.status(200).json({ ok: true, projects: services.listProjects() });
  });

  app.post("/api/public/projects", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    try {
      const body = parsePublicBody(request.body);
      const input: CreateProjectInput = {
        slug: readRequiredBodyString(body, "slug"),
        name: readRequiredBodyString(body, "name"),
        description: readOptionalBodyString(body.description),
      };
      const result = services.createProjectWithQueues ? services.createProjectWithQueues(input) : { project: services.createProject(input), queues: [] };

      response.status(201).json({ ok: true, ...result });
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.get("/api/public/projects/:projectId/tasks", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const projectId = readPathParam(request, "projectId");
    if (!projectId) {
      response.status(400).json(publicError("validation_error", "projectId is required"));
      return;
    }

    response.status(200).json({ ok: true, tasks: services.listProjectTasks({ projectId }) });
  });

  app.post("/api/public/projects/:projectId/tasks", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const projectId = readPathParam(request, "projectId");
    if (!projectId) {
      response.status(400).json(publicError("validation_error", "projectId is required"));
      return;
    }

    try {
      const body = parsePublicBody(request.body);
      const input: CreateTaskInput = {
        projectId,
        title: readRequiredBodyString(body, "title"),
        description: readOptionalBodyString(body.description),
        priority: readOptionalBodyInteger(body.priority),
        runtimeSource: readOptionalRuntimeSource(body.runtimeSource),
      };
      const result = services.createTask(input);
      const detail = services.readTaskDetail({ projectId, taskId: result.task.id });

      response.status(201).json({
        ok: true,
        task: detail.ok ? detail.task : result.task,
        event: result.event,
        outbox: result.outbox,
      });
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    const result = services.readTaskDetail(scope);
    if (!result.ok) {
      response.status(404).json(publicError(result.error.code, result.error.message));
      return;
    }

    response.status(200).json({ ok: true, task: result.task });
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/sessions", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    const result = services.readTaskDetail(scope);
    if (!result.ok) {
      response.status(404).json(publicError(result.error.code, result.error.message));
      return;
    }

    response.status(200).json({ ok: true, sessions: result.task.sessions });
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    const sessionId = readPathParam(request, "sessionId");
    if (!sessionId) {
      response.status(400).json(publicError("validation_error", "sessionId is required"));
      return;
    }

    const detail = services.readTaskDetail(scope);
    if (!detail.ok) {
      response.status(404).json(publicError(detail.error.code, detail.error.message));
      return;
    }

    const session = detail.task.sessions.find((candidate) => candidate.id === sessionId);
    if (!session) {
      response.status(404).json(publicError("not_found", `session not found: ${sessionId}`));
      return;
    }

    response.status(200).json({ ok: true, session, task: detail.task });
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/artifacts", requirePublicOperator, (request, response) => {
    respondArtifacts(response, options, request);
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/artifacts", requirePublicOperator, (request, response) => {
    respondArtifacts(response, options, request);
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/logs", requirePublicOperator, (request, response) => {
    respondLogs(response, options, request);
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/logs", requirePublicOperator, (request, response) => {
    respondLogs(response, options, request);
  });

  app.post("/api/public/projects/:projectId/uploads/plan", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    const storage = requirePublicStorage(options, response);
    if (!services || !storage) return;

    const projectId = readPathParam(request, "projectId");
    if (!projectId) {
      response.status(400).json(publicError("validation_error", "projectId is required"));
      return;
    }

    try {
      const body = parsePublicBody(request.body);
      const taskId = readOptionalBodyString(body.taskId);
      const sessionId = readOptionalBodyString(body.sessionId);
      const fileName = readRequiredBodyString(body, "fileName");
      const contentType = readOptionalBodyString(body.contentType);
      const projectExists = services.listProjects().some((project) => project.id === projectId);

      if (!projectExists) {
        response.status(404).json(publicError("not_found", `project not found: ${projectId}`));
        return;
      }
      if (taskId) {
        const detail = services.readTaskDetail({ projectId, taskId });
        if (!detail.ok) {
          response.status(404).json(publicError(detail.error.code, detail.error.message));
          return;
        }
        if (sessionId && !detail.task.sessions.some((session) => session.id === sessionId)) {
          response.status(404).json(publicError("not_found", `session not found: ${sessionId}`));
          return;
        }
      }

      const planned = storage.planObject(["projects", projectId, taskId ?? "project", sessionId ?? "uploads", fileName]);
      response.status(200).json({
        ok: true,
        upload: {
          adapter: planned.adapter,
          bucket: planned.bucket,
          key: planned.key,
          localPath: planned.localPath,
          method: planned.localPath ? "local_path" : "blob_put",
          contentType,
          expiresAt: null,
          headers: {},
          fields: {},
        },
      });
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/priority", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    try {
      const body = parsePublicBody(request.body);
      const priority = readRequiredBodyInteger(body, "priority");
      respondTaskMutation(response, services.updateTaskPriority({ ...scope, priority }));
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/backlog", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    respondTaskMutation(response, services.backlogTask(scope));
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/unblock", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    respondTaskMutation(response, services.unblockTask(scope));
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/cancel", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, request, response, "cancel");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/retry", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, request, response, "retry");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/dispatch", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, request, response, "start");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/stop", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, request, response, "stop");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/interrupt", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, request, response, "interrupt");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/cleanup", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, request, response, "cleanup");
  });

  for (const command of ["suspend", "resume", "fork"] as const) {
    app.post(`/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/${command}`, requirePublicOperator, (_request, response) => {
      response.status(501).json(publicError("unsupported_provider_command", `${command} is not supported by the configured runtime providers`));
    });
  }

  app.get("/api/public/providers/capabilities", requirePublicOperator, (_request, response) => {
    response.status(200).json({
      ok: true,
      defaultProvider: options.config.controlPlane.runtimeProvider,
      providers: readProviderCapabilities(options.config),
    });
  });
}

export function createPublicOperatorMiddleware(config: AppConfig): RequestHandler {
  return (request: PublicOperatorRequest, response: Response, next?: NextFunction): void => {
    const operatorId = readHeader(request, PUBLIC_OPERATOR_ID_HEADER);

    if (!operatorId) {
      response.status(401).json(publicError("unauthenticated", "operator auth required"));
      return;
    }

    if (operatorId !== config.operator.id) {
      response.status(403).json(publicError("forbidden", "operator auth invalid"));
      return;
    }

    request.publicOperator = config.operator;
    next?.();
  };
}

export function publicError(code: string, message: string): { readonly ok: false; readonly error: { readonly code: string; readonly message: string } } {
  return {
    ok: false,
    error: {
      code,
      message,
    },
  };
}

function readHeader(request: Request, name: string): string | null {
  const raw = request.headers?.[name];
  const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
  return value && value.length > 0 ? value : null;
}

function requirePublicServices(options: PublicApiOptions, response: Response): PublicApiServices | null {
  if (!options.services) {
    response.status(503).json(publicError("database_unavailable", "database is unavailable"));
    return null;
  }

  return options.services;
}

function requirePublicStorage(options: PublicApiOptions, response: Response): StorageAdapter | null {
  if (!options.storage) {
    response.status(503).json(publicError("storage_unavailable", "storage is unavailable"));
    return null;
  }

  return options.storage;
}

function respondArtifacts(response: Response, options: PublicApiOptions, request: Request): void {
  const detail = readScopedTaskDetail(response, options, request);
  if (!detail) return;

  const sessionId = readPathParam(request, "sessionId");
  const artifacts = sessionId ? detail.artifacts.filter((artifact) => artifact.sessionId === sessionId) : detail.artifacts;

  if (sessionId && !detail.sessions.some((session) => session.id === sessionId)) {
    response.status(404).json(publicError("not_found", `session not found: ${sessionId}`));
    return;
  }

  response.status(200).json({ ok: true, artifacts });
}

function respondLogs(response: Response, options: PublicApiOptions, request: Request): void {
  const detail = readScopedTaskDetail(response, options, request);
  if (!detail) return;

  const sessionId = readPathParam(request, "sessionId");
  const logStreams = sessionId ? detail.logStreams.filter((log) => log.sessionId === sessionId) : detail.logStreams;

  if (sessionId && !detail.sessions.some((session) => session.id === sessionId)) {
    response.status(404).json(publicError("not_found", `session not found: ${sessionId}`));
    return;
  }

  response.status(200).json({ ok: true, logStreams });
}

function readScopedTaskDetail(response: Response, options: PublicApiOptions, request: Request): PublicTaskDetail | null {
  const services = requirePublicServices(options, response);
  if (!services) return null;

  const scope = readTaskScope(request, response);
  if (!scope) return null;

  const detail = services.readTaskDetail(scope);
  if (!detail.ok) {
    response.status(404).json(publicError(detail.error.code, detail.error.message));
    return null;
  }

  return detail.task;
}

function respondTaskMutation(response: Response, result: TaskMutationResult): void {
  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json(publicError(result.error.code, result.error.message));
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    task: result.task,
    pendingCommands: result.task.pendingCommands,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondTaskCommand(
  options: PublicApiOptions,
  request: PublicOperatorRequest,
  response: Response,
  type: "start" | "cancel" | "retry",
): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const scope = readTaskScope(request, response);
  if (!scope) return;

  let payload: Readonly<Record<string, unknown>> = {};
  try {
    payload = parsePublicBody(request.body);
  } catch (error) {
    respondPublicException(response, error);
    return;
  }

  const result = services.requestCommand({
    ...scope,
    type,
    payload,
    requestedBy: request.publicOperator?.id ?? null,
  });
  respondCommandMutation(response, services, scope, result);
}

function respondSessionCommand(
  options: PublicApiOptions,
  request: PublicOperatorRequest,
  response: Response,
  type: "stop" | "interrupt" | "cleanup",
): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const scope = readTaskScope(request, response);
  if (!scope) return;

  const sessionId = readPathParam(request, "sessionId");
  if (!sessionId) {
    response.status(400).json(publicError("validation_error", "sessionId is required"));
    return;
  }

  let payload: Readonly<Record<string, unknown>> = {};
  try {
    payload = parsePublicBody(request.body);
  } catch (error) {
    respondPublicException(response, error);
    return;
  }

  const result = services.requestCommand({
    ...scope,
    sessionId,
    type,
    payload,
    requestedBy: request.publicOperator?.id ?? null,
  });
  respondCommandMutation(response, services, scope, result);
}

function respondCommandMutation(
  response: Response,
  services: PublicApiServices,
  scope: { readonly projectId: string; readonly taskId: string },
  result: RequestCommandResult,
): void {
  if (!result.ok) {
    response.status(commandErrorStatus(result.error.code)).json(publicError(result.error.code, result.error.message));
    return;
  }

  const detail = services.readTaskDetail(scope);
  response.status(200).json({
    ok: true,
    command: result.command,
    event: result.event,
    outbox: result.outbox,
    task: detail.ok ? detail.task : null,
    pendingCommands: detail.ok ? detail.task.pendingCommands : [],
  });
}

function commandErrorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "missing_scope") return 400;
  return 409;
}

function readTaskScope(request: Request, response: Response): { readonly projectId: string; readonly taskId: string } | null {
  const projectId = readPathParam(request, "projectId");
  const taskId = readPathParam(request, "taskId");

  if (!projectId || !taskId) {
    response.status(400).json(publicError("validation_error", "projectId and taskId are required"));
    return null;
  }

  return { projectId, taskId };
}

function readPathParam(request: Request, key: string): string | null {
  return request.params?.[key]?.trim() || null;
}

function parsePublicBody(value: unknown): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  return value as Readonly<Record<string, unknown>>;
}

function readRequiredBodyString(body: Readonly<Record<string, unknown>>, key: string): string {
  const value = readOptionalBodyString(body[key]);
  if (!value) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function readOptionalBodyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readRequiredBodyInteger(body: Readonly<Record<string, unknown>>, key: string): number {
  const value = readOptionalBodyInteger(body[key]);
  if (value === null) {
    throw new Error(`${key} is required`);
  }

  return value;
}

function readOptionalBodyInteger(value: unknown): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new Error("integer value is required");
  }

  return value;
}

function readOptionalRuntimeSource(value: unknown): TaskRuntimeSourceMetadata | null {
  if (value === undefined || value === null) return null;
  const body = parsePublicBody(value);

  return {
    repositoryUrl: readRequiredBodyString(body, "repositoryUrl"),
    baseRef: readRequiredBodyString(body, "baseRef"),
    taskBranchPrefix: readRequiredBodyString(body, "taskBranchPrefix"),
  };
}

function respondPublicException(response: Response, error: unknown): void {
  response.status(400).json(publicError("validation_error", error instanceof Error ? error.message : String(error)));
}

function readProviderCapabilities(config: AppConfig): readonly {
  readonly kind: RuntimeProviderName;
  readonly available: boolean;
  readonly configured: boolean;
  readonly capabilities: {
    readonly start: boolean;
    readonly stop: boolean;
    readonly suspend: boolean;
    readonly resume: boolean;
    readonly fork: boolean;
  };
  readonly requirements: Readonly<Record<string, boolean>>;
}[] {
  return [
    {
      kind: "fake",
      available: true,
      configured: true,
      capabilities: startStopCapabilities(),
      requirements: {},
    },
    {
      kind: "e2b",
      available: true,
      configured: config.controlPlane.e2b.apiKeyConfigured && Boolean(config.controlPlane.e2b.templateId || config.controlPlane.e2b.sandboxImageId),
      capabilities: startStopCapabilities(),
      requirements: {
        apiKeyConfigured: config.controlPlane.e2b.apiKeyConfigured,
        githubTokenConfigured: config.controlPlane.e2b.githubTokenConfigured,
        imageConfigured: Boolean(config.controlPlane.e2b.templateId || config.controlPlane.e2b.sandboxImageId),
      },
    },
    {
      kind: "docker",
      available: false,
      configured: false,
      capabilities: {
        start: false,
        stop: false,
        suspend: false,
        resume: false,
        fork: false,
      },
      requirements: {},
    },
  ];
}

function startStopCapabilities(): {
  readonly start: true;
  readonly stop: true;
  readonly suspend: false;
  readonly resume: false;
  readonly fork: false;
} {
  return {
    start: true,
    stop: true,
    suspend: false,
    resume: false,
    fork: false,
  };
}
