import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import type { AppConfig, OperatorIdentity } from "@agent-pool/config";
import type {
  CanonicalStateServices,
  CreateProjectInput,
  CreateTaskInput,
  PublicTaskDetail,
  RequestCommandResult,
  TaskMutationResult,
  TaskRuntimeSourceMetadata,
} from "@agent-pool/db";

export type PublicApiOptions = {
  readonly config: AppConfig;
  readonly services?: PublicApiServices | null;
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
  type: "cancel" | "retry",
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
