import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import type { Express, NextFunction, Request, RequestHandler, Response } from "express";

import type { AppConfig, OperatorIdentity, RuntimeProviderName } from "@agent-pool/config";
import type {
  CanonicalStateServices,
  CreateProjectInput,
  CreateTaskInput,
  NoteMutationResult,
  PublicEventSummary,
  PublicTaskDetail,
  RequestCommandResult,
  RequestSteeringResult,
  SteeringAttachmentReference,
  TaskMutationResult,
  TaskRuntimeSourceMetadata,
} from "@agent-pool/db";
import type { StorageAdapter } from "@agent-pool/storage";

export type PublicApiOptions = {
  readonly config: AppConfig;
  readonly services?: PublicApiServices | null;
  readonly storage?: StorageAdapter | null;
  readonly sseHub?: PublicSseHub;
};

export type PublicOperatorRequest = Request & {
  publicOperator?: OperatorIdentity;
};

const PUBLIC_OPERATOR_ID_HEADER = "x-agent-pool-operator-id";

type PublicApiServices = Pick<
  CanonicalStateServices,
  | "backlogTask"
  | "createProject"
  | "createTaskNote"
  | "deleteTaskNote"
  | "createTask"
  | "listPublicEvents"
  | "listProjectTasks"
  | "listProjects"
  | "readTaskDetail"
  | "requestCommand"
  | "requestSteering"
  | "unblockTask"
  | "updateTaskNote"
  | "updateTaskPriority"
> & {
  readonly createProjectWithQueues?: (input: CreateProjectInput) => {
    readonly project: unknown;
    readonly queues: unknown;
  };
};

type PublicSseEvent = PublicEventSummary;

type PublicSseSubscription = {
  readonly projectId: string;
  readonly taskId: string | null;
  readonly sessionId: string | null;
  readonly dispatchOnly: boolean;
  readonly response: Response;
};

export type PublicSseHub = {
  readonly clientCount: number;
  subscribe(subscription: PublicSseSubscription): () => void;
  publish(event: PublicSseEvent): void;
};

type PublicRuntimeReadinessStatus = "ready" | "blocked" | "warning" | "unknown";
type PublicRuntimeReadinessCheckStatus = "pass" | "block" | "warn" | "unknown";

type PublicRuntimeReadinessCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: PublicRuntimeReadinessCheckStatus;
  readonly detail: string;
  readonly prerequisite: string | null;
  readonly nextAction: string | null;
};

type PublicRuntimeReadinessLink = {
  readonly label: string;
  readonly href: string;
  readonly kind: "api" | "sse" | "task" | "evidence";
};

type PublicRuntimeReadinessSummary = {
  readonly status: PublicRuntimeReadinessStatus;
  readonly generatedAt: string;
  readonly runtimeProvider: RuntimeProviderName;
  readonly agentRunnerMode: string;
  readonly smokeProjectId: string;
  readonly smokeEnabled: boolean;
  readonly checks: readonly PublicRuntimeReadinessCheck[];
  readonly missingPrerequisites: readonly string[];
  readonly warnings: readonly string[];
  readonly lastSmoke: {
    readonly status: "available" | "missing" | "unavailable" | "unknown";
    readonly projectId: string;
    readonly summary: string;
    readonly taskId: string | null;
    readonly taskTitle: string | null;
    readonly taskStatus: string | null;
    readonly sessionId: string | null;
    readonly sessionStatus: string | null;
    readonly runtimeProvider: string | null;
    readonly updatedAt: string | null;
    readonly evidence: {
      readonly status: "task-diagnostics" | "not-recorded" | "unavailable";
      readonly summary: string;
      readonly command: string;
    };
    readonly links: readonly PublicRuntimeReadinessLink[];
  };
  readonly links: readonly PublicRuntimeReadinessLink[];
  readonly redaction: {
    readonly secrets: "redacted";
    readonly databasePaths: "omitted";
  };
};

export function registerPublicApiRoutes(app: Express, options: PublicApiOptions): void {
  const requirePublicOperator = createPublicOperatorMiddleware(options.config);
  const sseHub = options.sseHub ?? createPublicSseHub();

  app.post("/api/public/auth/login", (request, response) => {
    const auth = requireConfiguredPublicAuth(options.config, response);
    if (!auth) return;

    try {
      const body = parsePublicBody(request.body);
      const operatorId = readRequiredBodyString(body, "operatorId");
      const password = readRequiredBodyString(body, "password");

      if (operatorId !== options.config.operator.id || !constantTimeEqual(password, auth.operatorPassword)) {
        response.status(401).json(publicError("invalid_credentials", "operator credentials are invalid"));
        return;
      }

      setPublicSessionCookie(response, options.config);
      response.status(200).json({
        ok: true,
        operator: options.config.operator,
        authMode: options.config.authMode,
        expiresInSeconds: auth.sessionTtlSeconds,
      });
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.post("/api/public/auth/logout", (_request, response) => {
    clearPublicSessionCookie(response, options.config);
    response.status(200).json({ ok: true });
  });

  app.get("/api/public/me", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    response.status(200).json({
      ok: true,
      operator: request.publicOperator,
      authMode: options.config.authMode,
    });
  });

  app.get("/api/public/runtime/readiness", requirePublicOperator, (_request, response) => {
    response.status(200).json({
      ok: true,
      readiness: buildPublicRuntimeReadiness(options.config, options.services ?? null),
    });
  });

  app.get("/api/public/projects/:projectId/events", requirePublicOperator, (request, response) => {
    respondSseStream(response, options, sseHub, request, { dispatchOnly: false });
  });

  app.get("/api/public/projects/:projectId/dispatch/events", requirePublicOperator, (request, response) => {
    respondSseStream(response, options, sseHub, request, { dispatchOnly: true });
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/events", requirePublicOperator, (request, response) => {
    respondSseStream(response, options, sseHub, request, { dispatchOnly: false });
  });

  app.get("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/events", requirePublicOperator, (request, response) => {
    respondSseStream(response, options, sseHub, request, { dispatchOnly: false });
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
      const runtimeSource = readOptionalRuntimeSource(body.runtimeSource);
      const runtimePolicyError = validateRuntimeSourcePolicy(options.config, runtimeSource);
      if (runtimePolicyError) {
        response.status(400).json(publicError("validation_error", runtimePolicyError));
        return;
      }
      const input: CreateTaskInput = {
        projectId,
        title: readRequiredBodyString(body, "title"),
        description: readOptionalBodyString(body.description),
        priority: readOptionalBodyInteger(body.priority),
        runtimeSource,
      };
      if (!services.listProjects().some((project) => project.id === projectId)) {
        response.status(404).json(publicError("not_found", `project not found: ${projectId}`));
        return;
      }
      const result = services.createTask(input);
      const detail = services.readTaskDetail({ projectId, taskId: result.task.id });

      response.status(201).json({
        ok: true,
        task: detail.ok ? detail.task : result.task,
        event: result.event,
        outbox: result.outbox,
      });
      sseHub.publish(publicEventFromMutation(result.event, { projectId, taskId: result.task.id }));
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

  app.get("/api/public/projects/:projectId/tasks/:taskId/notes", requirePublicOperator, (request, response) => {
    const detail = readScopedTaskDetail(response, options, request);
    if (!detail) return;

    response.status(200).json({ ok: true, notes: detail.notes });
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/notes", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondCreateNote(options, sseHub, request, response);
  });

  app.patch("/api/public/projects/:projectId/tasks/:taskId/notes/:noteId", requirePublicOperator, (request, response) => {
    respondUpdateNote(options, sseHub, request, response);
  });

  app.delete("/api/public/projects/:projectId/tasks/:taskId/notes/:noteId", requirePublicOperator, (request, response) => {
    respondDeleteNote(options, sseHub, request, response);
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
      respondTaskMutation(response, sseHub, scope, services.updateTaskPriority({ ...scope, priority }));
    } catch (error) {
      respondPublicException(response, error);
    }
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/backlog", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    respondTaskMutation(response, sseHub, scope, services.backlogTask(scope));
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/unblock", requirePublicOperator, (request, response) => {
    const services = requirePublicServices(options, response);
    if (!services) return;

    const scope = readTaskScope(request, response);
    if (!scope) return;

    respondTaskMutation(response, sseHub, scope, services.unblockTask(scope));
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/cancel", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, sseHub, request, response, "cancel");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/retry", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, sseHub, request, response, "retry");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/dispatch", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondTaskCommand(options, sseHub, request, response, "start");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/stop", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, sseHub, request, response, "stop");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/interrupt", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, sseHub, request, response, "interrupt");
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/steer", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSteeringCommand(options, sseHub, request, response);
  });

  app.post("/api/public/projects/:projectId/tasks/:taskId/sessions/:sessionId/cleanup", requirePublicOperator, (request: PublicOperatorRequest, response) => {
    respondSessionCommand(options, sseHub, request, response, "cleanup");
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

    if (config.authMode === "test") {
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
      return;
    }

    if (!requireConfiguredPublicAuth(config, response)) return;

    const session = readPublicSessionCookie(request, config);
    if (!session.ok) {
      response.status(401).json(publicError("unauthenticated", session.reason));
      return;
    }

    if (!operatorId || operatorId !== session.operatorId || operatorId !== config.operator.id) {
      response.status(403).json(publicError("forbidden", "operator session identity mismatch"));
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

function requireConfiguredPublicAuth(
  config: AppConfig,
  response: Response,
): { readonly operatorPassword: string; readonly sessionSecret: string; readonly sessionTtlSeconds: number } | null {
  const operatorPassword = config.publicAuth.operatorPassword;
  const sessionSecret = config.publicAuth.sessionSecret;

  if (!operatorPassword || !sessionSecret) {
    response.status(503).json(publicError("auth_misconfigured", "operator cookie auth is not configured"));
    return null;
  }

  return {
    operatorPassword,
    sessionSecret,
    sessionTtlSeconds: config.publicAuth.sessionTtlSeconds,
  };
}

function setPublicSessionCookie(response: Response, config: AppConfig): void {
  const auth = config.publicAuth;
  if (!auth.sessionSecret) return;
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    operatorId: config.operator.id,
    iat: now,
    exp: now + auth.sessionTtlSeconds,
    nonce: randomBytes(16).toString("base64url"),
  };
  const value = signPublicSessionPayload(payload, auth.sessionSecret);
  response.setHeader(
    "set-cookie",
    serializeCookie(auth.cookieName, value, {
      maxAge: auth.sessionTtlSeconds,
      secure: auth.cookieSecure,
    }),
  );
}

function clearPublicSessionCookie(response: Response, config: AppConfig): void {
  response.setHeader(
    "set-cookie",
    serializeCookie(config.publicAuth.cookieName, "", {
      maxAge: 0,
      secure: config.publicAuth.cookieSecure,
    }),
  );
}

function readPublicSessionCookie(
  request: Request,
  config: AppConfig,
): { readonly ok: true; readonly operatorId: string } | { readonly ok: false; readonly reason: string } {
  const secret = config.publicAuth.sessionSecret;
  if (!secret) return { ok: false, reason: "operator cookie auth is not configured" };
  const cookie = readCookie(request, config.publicAuth.cookieName);
  if (!cookie) return { ok: false, reason: "operator session required" };

  const parsed = verifyPublicSessionValue(cookie, secret);
  if (!parsed.ok) return parsed;
  if (parsed.operatorId !== config.operator.id) {
    return { ok: false, reason: "operator session invalid" };
  }

  return parsed;
}

function signPublicSessionPayload(
  payload: { readonly operatorId: string; readonly iat: number; readonly exp: number; readonly nonce: string },
  secret: string,
): string {
  const encodedPayload = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signature = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  return `${encodedPayload}.${signature}`;
}

function verifyPublicSessionValue(
  value: string,
  secret: string,
): { readonly ok: true; readonly operatorId: string } | { readonly ok: false; readonly reason: string } {
  const [encodedPayload, signature, extra] = value.split(".");
  if (!encodedPayload || !signature || extra !== undefined) return { ok: false, reason: "operator session invalid" };

  const expected = createHmac("sha256", secret).update(encodedPayload).digest("base64url");
  if (!constantTimeEqual(signature, expected)) return { ok: false, reason: "operator session invalid" };

  try {
    const payload = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8")) as {
      readonly operatorId?: unknown;
      readonly exp?: unknown;
    };
    if (typeof payload.operatorId !== "string" || typeof payload.exp !== "number") {
      return { ok: false, reason: "operator session invalid" };
    }
    if (!Number.isFinite(payload.exp) || payload.exp <= Math.floor(Date.now() / 1000)) {
      return { ok: false, reason: "operator session expired" };
    }

    return { ok: true, operatorId: payload.operatorId };
  } catch {
    return { ok: false, reason: "operator session invalid" };
  }
}

function readCookie(request: Request, name: string): string | null {
  const rawCookieHeader = request.headers?.cookie;
  const cookieHeader = Array.isArray(rawCookieHeader) ? rawCookieHeader[0] : rawCookieHeader;
  if (!cookieHeader) return null;

  for (const part of cookieHeader.split(";")) {
    const [rawName, ...rawValue] = part.trim().split("=");
    if (rawName === name) return rawValue.join("=") || null;
  }

  return null;
}

function serializeCookie(
  name: string,
  value: string,
  options: { readonly maxAge: number; readonly secure: boolean },
): string {
  const parts = [
    `${name}=${value}`,
    `Max-Age=${options.maxAge}`,
    "Path=/api/public",
    "HttpOnly",
    "SameSite=Strict",
  ];
  if (options.secure) parts.push("Secure");
  return parts.join("; ");
}

function constantTimeEqual(left: string, right: string): boolean {
  return timingSafeEqual(createHash("sha256").update(left).digest(), createHash("sha256").update(right).digest());
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

function buildPublicRuntimeReadiness(config: AppConfig, services: PublicApiServices | null): PublicRuntimeReadinessSummary {
  const checks = buildRuntimeReadinessChecks(config);
  const missingPrerequisites = checks
    .filter((check) => check.status === "block" && check.prerequisite)
    .map((check) => check.prerequisite as string);
  const warnings = checks.filter((check) => check.status === "warn").map((check) => check.detail);
  const status = summarizeRuntimeReadinessStatus(checks);
  const lastSmoke = buildLastSmokeReadiness(config, services);

  return {
    status,
    generatedAt: new Date().toISOString(),
    runtimeProvider: config.controlPlane.runtimeProvider,
    agentRunnerMode: config.controlPlane.e2b.agentRunnerMode,
    smokeProjectId: config.controlPlane.smokeProjectId,
    smokeEnabled: config.controlPlane.smokeEnabled,
    checks,
    missingPrerequisites,
    warnings,
    lastSmoke,
    links: [
      {
        label: "Smoke project events",
        href: `/api/public/projects/${encodeURIComponent(config.controlPlane.smokeProjectId)}/events`,
        kind: "sse",
      },
      ...lastSmoke.links,
    ],
    redaction: {
      secrets: "redacted",
      databasePaths: "omitted",
    },
  };
}

function buildRuntimeReadinessChecks(config: AppConfig): readonly PublicRuntimeReadinessCheck[] {
  const provider = config.controlPlane.runtimeProvider;
  const e2b = config.controlPlane.e2b;
  const checks: PublicRuntimeReadinessCheck[] = [
    {
      id: "runtime-provider",
      label: "Runtime provider",
      status: provider === "e2b" ? "pass" : provider === "fake" ? "warn" : "unknown",
      detail:
        provider === "e2b"
          ? "E2B is configured as the active runtime provider."
          : provider === "fake"
            ? "Fake runtime is active; live E2B sandbox runs will not execute."
            : `Runtime provider ${provider} does not have public readiness coverage yet.`,
      prerequisite: provider === "e2b" ? null : "RUNTIME_PROVIDER=e2b",
      nextAction: provider === "e2b" ? null : "Switch RUNTIME_PROVIDER to e2b before live sandbox testing.",
    },
    {
      id: "compose-smoke",
      label: "Smoke diagnostics",
      status: config.controlPlane.smokeEnabled ? "pass" : "warn",
      detail: config.controlPlane.smokeEnabled
        ? "Smoke fixtures are enabled for task/session diagnostics."
        : "Smoke fixtures are disabled, so the operator panel may not find a recent smoke task.",
      prerequisite: config.controlPlane.smokeEnabled ? null : "COMPOSE_SMOKE_ENABLED=true",
      nextAction: config.controlPlane.smokeEnabled ? null : "Enable COMPOSE_SMOKE_ENABLED for local readiness diagnostics.",
    },
  ];

  if (provider !== "e2b") {
    return checks;
  }

  checks.push(
    {
      id: "e2b-credential",
      label: "E2B API key",
      status: e2b.apiKeyConfigured ? "pass" : "block",
      detail: e2b.apiKeyConfigured ? `${e2b.apiKeyEnvName} is configured and redacted.` : `${e2b.apiKeyEnvName} is missing.`,
      prerequisite: e2b.apiKeyConfigured ? null : e2b.apiKeyEnvName,
      nextAction: e2b.apiKeyConfigured ? null : `Set ${e2b.apiKeyEnvName} in the runtime environment.`,
    },
    {
      id: "e2b-template",
      label: "E2B template",
      status: e2b.templateId || e2b.sandboxImageId ? "pass" : "block",
      detail: e2b.templateId || e2b.sandboxImageId ? "Template or sandbox image id is configured and redacted." : "No E2B template or sandbox image id is configured.",
      prerequisite: e2b.templateId || e2b.sandboxImageId ? null : "E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID",
      nextAction: e2b.templateId || e2b.sandboxImageId ? null : "Build the Agent Pool E2B template and set its id.",
    },
    {
      id: "callback-url",
      label: "Bridge callback URL",
      ...summarizeCallbackReadiness(config.bridge.callbackBaseUrl),
    },
  );

  if (e2b.agentRunnerMode !== "codex") {
    checks.push({
      id: "agent-runner-mode",
      label: "Agent runner",
      status: "warn",
      detail: "E2B is configured for bridge smoke mode instead of the Codex PR runner.",
      prerequisite: "AGENT_RUNNER_MODE=codex",
      nextAction: "Set AGENT_RUNNER_MODE=codex for real agent sandbox testing.",
    });
    return checks;
  }

  checks.push(
    {
      id: "codex-api-key",
      label: "Codex API key",
      status: e2b.codexApiKeyConfigured ? "pass" : "block",
      detail: e2b.codexApiKeyConfigured ? `${e2b.codexApiKeyEnvName} is configured and redacted.` : `${e2b.codexApiKeyEnvName} is missing.`,
      prerequisite: e2b.codexApiKeyConfigured ? null : e2b.codexApiKeyEnvName,
      nextAction: e2b.codexApiKeyConfigured ? null : `Set ${e2b.codexApiKeyEnvName} for non-interactive Codex execution.`,
    },
    {
      id: "github-app-broker",
      label: "GitHub App broker",
      status: config.githubApp.configured ? "pass" : "block",
      detail: config.githubApp.configured
        ? "GitHub App installation token broker is configured."
        : "GitHub App installation token broker is not fully configured.",
      prerequisite: config.githubApp.configured ? null : "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID",
      nextAction: config.githubApp.configured
        ? null
        : "Set GitHub App id, private key, and installation id so only short-lived repository tokens enter the sandbox.",
    },
    {
      id: "egress-mode",
      label: "Egress mode",
      status: e2b.localAllowDirectEgress ? "warn" : e2b.egressProxyUrl && e2b.egressProxyAllowOut.length > 0 ? "pass" : "block",
      detail: e2b.localAllowDirectEgress
        ? "Direct egress override is enabled for test mode."
        : e2b.egressProxyUrl && e2b.egressProxyAllowOut.length > 0
          ? "Proxy-only egress is configured; proxy URL and allow-out targets are redacted."
          : "Proxy-only egress is not fully configured.",
      prerequisite: e2b.localAllowDirectEgress || (e2b.egressProxyUrl && e2b.egressProxyAllowOut.length > 0)
        ? null
        : "EGRESS_PROXY_URL and EGRESS_PROXY_ALLOW_OUT",
      nextAction: e2b.localAllowDirectEgress || (e2b.egressProxyUrl && e2b.egressProxyAllowOut.length > 0)
        ? null
        : "Set the egress gateway proxy URL and static allow-out target before live Codex runs.",
    },
    {
      id: "allowed-egress-domains",
      label: "Allowed egress domains",
      status: e2b.allowedEgressDomains.length > 0 ? "pass" : "block",
      detail: e2b.allowedEgressDomains.length > 0
        ? `${e2b.allowedEgressDomains.length} global egress domain(s) are configured.`
        : "No global egress domain allowlist is configured.",
      prerequisite: e2b.allowedEgressDomains.length > 0 ? null : "AGENT_POOL_ALLOWED_EGRESS_DOMAINS",
      nextAction: e2b.allowedEgressDomains.length > 0
        ? null
        : "Set AGENT_POOL_ALLOWED_EGRESS_DOMAINS before accepting task-declared runtime source domains.",
    },
  );

  return checks;
}

function summarizeCallbackReadiness(
  callbackBaseUrl: string,
): Pick<PublicRuntimeReadinessCheck, "status" | "detail" | "prerequisite" | "nextAction"> {
  try {
    const url = new URL(callbackBaseUrl);
    const isLocalHost = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (isLocalHost) {
      return {
        status: "block",
        detail: "Bridge callback URL is local-only; E2B cannot call it without a public tunnel.",
        prerequisite: "BRIDGE_CALLBACK_BASE_URL",
        nextAction: "Point BRIDGE_CALLBACK_BASE_URL at the public Caddy or tunnel URL.",
      };
    }
    if (url.protocol !== "https:") {
      return {
        status: "warn",
        detail: "Bridge callback URL is not HTTPS.",
        prerequisite: "BRIDGE_CALLBACK_BASE_URL=https://...",
        nextAction: "Use an HTTPS callback URL for live E2B sessions.",
      };
    }

    return {
      status: "pass",
      detail: "Bridge callback URL is public HTTPS.",
      prerequisite: null,
      nextAction: null,
    };
  } catch {
    return {
      status: "block",
      detail: "Bridge callback URL is invalid.",
      prerequisite: "BRIDGE_CALLBACK_BASE_URL",
      nextAction: "Set BRIDGE_CALLBACK_BASE_URL to the public API edge URL.",
    };
  }
}

function summarizeRuntimeReadinessStatus(checks: readonly PublicRuntimeReadinessCheck[]): PublicRuntimeReadinessStatus {
  if (checks.some((check) => check.status === "block")) return "blocked";
  if (checks.some((check) => check.status === "warn")) return "warning";
  if (checks.some((check) => check.status === "unknown")) return "unknown";
  return "ready";
}

function buildLastSmokeReadiness(
  config: AppConfig,
  services: PublicApiServices | null,
): PublicRuntimeReadinessSummary["lastSmoke"] {
  const projectId = config.controlPlane.smokeProjectId;
  const evidenceCommand = "bun run smoke:e2b -- --evidence --agent-runner-mode codex";

  if (!services) {
    return {
      status: "unavailable",
      projectId,
      summary: "Database-backed public services are unavailable, so smoke task diagnostics cannot be read.",
      taskId: null,
      taskTitle: null,
      taskStatus: null,
      sessionId: null,
      sessionStatus: null,
      runtimeProvider: null,
      updatedAt: null,
      evidence: {
        status: "unavailable",
        summary: "Evidence status is unavailable without public services.",
        command: evidenceCommand,
      },
      links: [],
    };
  }

  const project = services.listProjects().find((candidate) => candidate.id === projectId);
  if (!project) {
    return {
      status: "missing",
      projectId,
      summary: `Smoke project ${projectId} has not been created yet.`,
      taskId: null,
      taskTitle: null,
      taskStatus: null,
      sessionId: null,
      sessionStatus: null,
      runtimeProvider: null,
      updatedAt: null,
      evidence: {
        status: "not-recorded",
        summary: "No smoke evidence task is available yet.",
        command: evidenceCommand,
      },
      links: [
        {
          label: "Smoke project events",
          href: `/api/public/projects/${encodeURIComponent(projectId)}/events`,
          kind: "sse",
        },
      ],
    };
  }

  const latestTask = [...services.listProjectTasks({ projectId })].sort(compareTasksByUpdatedAt).at(0) ?? null;
  if (!latestTask) {
    return {
      status: "missing",
      projectId,
      summary: `Smoke project ${project.name} has no tasks yet.`,
      taskId: null,
      taskTitle: null,
      taskStatus: null,
      sessionId: null,
      sessionStatus: null,
      runtimeProvider: null,
      updatedAt: project.updatedAt,
      evidence: {
        status: "not-recorded",
        summary: "No smoke evidence task is available yet.",
        command: evidenceCommand,
      },
      links: [
        {
          label: "Smoke project events",
          href: `/api/public/projects/${encodeURIComponent(projectId)}/events`,
          kind: "sse",
        },
      ],
    };
  }

  return {
    status: "available",
    projectId,
    summary: `Latest smoke task is ${latestTask.status}.`,
    taskId: latestTask.id,
    taskTitle: latestTask.title,
    taskStatus: latestTask.status,
    sessionId: latestTask.latestSession?.id ?? null,
    sessionStatus: latestTask.latestSession?.status ?? null,
    runtimeProvider: latestTask.latestSession?.runtimeProvider ?? null,
    updatedAt: latestTask.updatedAt,
    evidence: {
      status: "task-diagnostics",
      summary: "Use the task detail events, logs, and security timeline as the current smoke evidence source.",
      command: evidenceCommand,
    },
    links: [
      {
        label: "Latest smoke task",
        href: `/api/public/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(latestTask.id)}`,
        kind: "task",
      },
      {
        label: "Smoke project events",
        href: `/api/public/projects/${encodeURIComponent(projectId)}/events`,
        kind: "sse",
      },
    ],
  };
}

function compareTasksByUpdatedAt(
  left: { readonly updatedAt: string; readonly createdAt: string; readonly displayId: number },
  right: { readonly updatedAt: string; readonly createdAt: string; readonly displayId: number },
): number {
  const updatedDelta = Date.parse(right.updatedAt) - Date.parse(left.updatedAt);
  if (updatedDelta !== 0) return updatedDelta;

  const createdDelta = Date.parse(right.createdAt) - Date.parse(left.createdAt);
  if (createdDelta !== 0) return createdDelta;

  return right.displayId - left.displayId;
}

function respondSseStream(
  response: Response,
  options: PublicApiOptions,
  sseHub: PublicSseHub,
  request: Request,
  stream: { readonly dispatchOnly: boolean },
): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const projectId = readPathParam(request, "projectId");
  const taskId = readPathParam(request, "taskId");
  const sessionId = readPathParam(request, "sessionId");

  if (!projectId) {
    response.status(400).json(publicError("validation_error", "projectId is required"));
    return;
  }

  if (taskId || sessionId) {
    if (!taskId) {
      response.status(400).json(publicError("validation_error", "taskId is required"));
      return;
    }

    const detail = services.readTaskDetail({ projectId, taskId });
    if (!detail.ok) {
      response.status(404).json(publicError(detail.error.code, detail.error.message));
      return;
    }

    if (sessionId && !detail.task.sessions.some((session) => session.id === sessionId)) {
      response.status(404).json(publicError("not_found", `session not found: ${sessionId}`));
      return;
    }
  } else if (!services.listProjects().some((project) => project.id === projectId)) {
    response.status(404).json(publicError("not_found", `project not found: ${projectId}`));
    return;
  }

  const replay = services.listPublicEvents({
    projectId,
    taskId,
    sessionId,
    dispatchOnly: stream.dispatchOnly,
    lastEventId: readHeader(request, "last-event-id"),
  });

  response.setHeader("content-type", "text/event-stream; charset=utf-8");
  response.setHeader("cache-control", "no-cache, no-transform");
  response.setHeader("connection", "keep-alive");
  response.setHeader("x-accel-buffering", "no");
  response.flushHeaders?.();
  response.write(": connected\n\n");

  for (const event of replay) {
    writeSseEvent(response, event);
  }

  const cleanup = sseHub.subscribe({
    projectId,
    taskId: taskId ?? null,
    sessionId: sessionId ?? null,
    dispatchOnly: stream.dispatchOnly,
    response,
  });
  request.on?.("close", cleanup);
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

export function createPublicSseHub(): PublicSseHub {
  const clients = new Set<PublicSseSubscription>();

  return {
    get clientCount(): number {
      return clients.size;
    },
    subscribe(subscription): () => void {
      clients.add(subscription);
      return () => {
        clients.delete(subscription);
        subscription.response.end();
      };
    },
    publish(event): void {
      for (const client of clients) {
        if (matchesSseSubscription(client, event)) {
          writeSseEvent(client.response, event);
        }
      }
    },
  };
}

function matchesSseSubscription(subscription: PublicSseSubscription, event: PublicSseEvent): boolean {
  if (subscription.projectId !== event.projectId) return false;
  if (subscription.taskId && event.taskId !== subscription.taskId) return false;
  if (subscription.sessionId && event.sessionId !== subscription.sessionId) return false;
  if (subscription.dispatchOnly && !event.commandId && !event.type.startsWith("command.") && event.type !== "task.claimed") return false;

  return true;
}

function writeSseEvent(response: Response, event: PublicSseEvent): void {
  response.write(`id: ${event.id}\n`);
  response.write(`event: ${event.type.replace(/[^A-Za-z0-9_.-]/g, "_")}\n`);
  response.write(`data: ${JSON.stringify(event)}\n\n`);
}

function publicEventFromMutation(
  event: { readonly id: string; readonly projectId: string; readonly type: string },
  scope: { readonly projectId: string; readonly taskId?: string | null; readonly sessionId?: string | null; readonly commandId?: string | null },
): PublicSseEvent {
  return {
    id: event.id,
    projectId: event.projectId,
    taskId: scope.taskId ?? null,
    sessionId: scope.sessionId ?? null,
    commandId: scope.commandId ?? null,
    type: event.type,
    payload: {},
    createdAt: new Date(0).toISOString(),
  };
}

function respondTaskMutation(
  response: Response,
  sseHub: PublicSseHub,
  scope: { readonly projectId: string; readonly taskId: string },
  result: TaskMutationResult,
): void {
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
  sseHub.publish(publicEventFromMutation(result.event, scope));
}

function respondTaskCommand(
  options: PublicApiOptions,
  sseHub: PublicSseHub,
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
  respondCommandMutation(response, sseHub, services, scope, result);
}

function respondSessionCommand(
  options: PublicApiOptions,
  sseHub: PublicSseHub,
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
  respondCommandMutation(response, sseHub, services, { ...scope, sessionId }, result);
}

function respondSteeringCommand(
  options: PublicApiOptions,
  sseHub: PublicSseHub,
  request: PublicOperatorRequest,
  response: Response,
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

  try {
    const body = parsePublicBody(request.body);
    const result = services.requestSteering({
      ...scope,
      sessionId,
      body: readRequiredBodyString(body, "body"),
      attachments: readSteeringAttachments(body.attachments),
      requestedBy: request.publicOperator?.id ?? null,
    });
    respondSteeringMutation(response, sseHub, services, { ...scope, sessionId }, result);
  } catch (error) {
    respondPublicException(response, error);
  }
}

function respondCreateNote(options: PublicApiOptions, sseHub: PublicSseHub, request: PublicOperatorRequest, response: Response): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const scope = readTaskScope(request, response);
  if (!scope) return;

  try {
    const body = parsePublicBody(request.body);
    const result = services.createTaskNote({
      ...scope,
      sessionId: readOptionalBodyString(body.sessionId),
      authorId: request.publicOperator?.id ?? null,
      body: readRequiredBodyString(body, "body"),
    });
    respondNoteMutation(response, sseHub, scope, result, 201);
  } catch (error) {
    respondPublicException(response, error);
  }
}

function respondUpdateNote(options: PublicApiOptions, sseHub: PublicSseHub, request: Request, response: Response): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const scope = readTaskScope(request, response);
  if (!scope) return;

  const noteId = readPathParam(request, "noteId");
  if (!noteId) {
    response.status(400).json(publicError("validation_error", "noteId is required"));
    return;
  }

  try {
    const body = parsePublicBody(request.body);
    const result = services.updateTaskNote({ ...scope, noteId, body: readRequiredBodyString(body, "body") });
    respondNoteMutation(response, sseHub, scope, result, 200);
  } catch (error) {
    respondPublicException(response, error);
  }
}

function respondDeleteNote(options: PublicApiOptions, sseHub: PublicSseHub, request: Request, response: Response): void {
  const services = requirePublicServices(options, response);
  if (!services) return;

  const scope = readTaskScope(request, response);
  if (!scope) return;

  const noteId = readPathParam(request, "noteId");
  if (!noteId) {
    response.status(400).json(publicError("validation_error", "noteId is required"));
    return;
  }

  const result = services.deleteTaskNote({ ...scope, noteId });
  respondNoteMutation(response, sseHub, scope, result, 200);
}

function respondCommandMutation(
  response: Response,
  sseHub: PublicSseHub,
  services: PublicApiServices,
  scope: { readonly projectId: string; readonly taskId: string; readonly sessionId?: string | null },
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
  sseHub.publish(
    publicEventFromMutation(result.event, {
      projectId: scope.projectId,
      taskId: scope.taskId,
      sessionId: scope.sessionId ?? result.command.sessionId,
      commandId: result.command.id,
    }),
  );
}

function respondNoteMutation(
  response: Response,
  sseHub: PublicSseHub,
  scope: { readonly projectId: string; readonly taskId: string },
  result: NoteMutationResult,
  successStatus: number,
): void {
  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 400).json(publicError(result.error.code, result.error.message));
    return;
  }

  response.status(successStatus).json({
    ok: true,
    note: result.note,
    task: result.task,
    event: result.event,
    outbox: result.outbox,
  });
  sseHub.publish(publicEventFromMutation(result.event, { projectId: scope.projectId, taskId: scope.taskId, sessionId: result.note.sessionId }));
}

function respondSteeringMutation(
  response: Response,
  sseHub: PublicSseHub,
  services: PublicApiServices,
  scope: { readonly projectId: string; readonly taskId: string; readonly sessionId: string },
  result: RequestSteeringResult,
): void {
  if (!result.ok) {
    response.status(commandErrorStatus(result.error.code)).json(publicError(result.error.code, result.error.message));
    return;
  }

  const detail = services.readTaskDetail(scope);
  response.status(200).json({
    ok: true,
    steering: result.steering,
    command: result.command,
    event: result.event,
    outbox: result.outbox,
    task: detail.ok ? detail.task : null,
    pendingCommands: detail.ok ? detail.task.pendingCommands : [],
  });
  sseHub.publish(
    publicEventFromMutation(result.event, {
      projectId: scope.projectId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
      commandId: result.command.id,
    }),
  );
}

function commandErrorStatus(code: string): number {
  if (code === "not_found") return 404;
  if (code === "missing_scope" || code === "validation_error") return 400;
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
    allowedEgressDomains: readOptionalStringArray(body.allowedEgressDomains),
    commandProfile: readOptionalBodyString(body.commandProfile),
  };
}

function validateRuntimeSourcePolicy(config: AppConfig, runtimeSource: TaskRuntimeSourceMetadata | null): string | null {
  if (config.controlPlane.runtimeProvider !== "e2b" || config.controlPlane.e2b.agentRunnerMode !== "codex") {
    return null;
  }

  if (!runtimeSource) {
    return "runtimeSource is required when RUNTIME_PROVIDER=e2b and AGENT_RUNNER_MODE=codex";
  }
  if (runtimeSource.commandProfile !== config.controlPlane.e2b.codexCommandProfile) {
    return `runtimeSource.commandProfile must be ${config.controlPlane.e2b.codexCommandProfile}`;
  }

  const requested = (runtimeSource.allowedEgressDomains ?? []).map((domain) => normalizeRuntimeSourceDomain(domain));
  if (requested.length === 0) {
    return "runtimeSource.allowedEgressDomains is required when AGENT_RUNNER_MODE=codex";
  }

  const globalAllowed = new Set(config.controlPlane.e2b.allowedEgressDomains);
  const rejected = requested.find((domain) => !globalAllowed.has(domain));
  if (rejected) {
    return `runtimeSource.allowedEgressDomains contains a domain outside the global allowlist: ${rejected}`;
  }

  let repositoryHost: string;
  try {
    repositoryHost = new URL(runtimeSource.repositoryUrl).hostname.toLowerCase();
  } catch {
    return "runtimeSource.repositoryUrl must be a valid URL";
  }
  if (!requested.includes(repositoryHost)) {
    return "runtimeSource.allowedEgressDomains must include the repository host";
  }

  return null;
}

function normalizeRuntimeSourceDomain(value: string): string {
  return value.trim().toLowerCase();
}

function readOptionalStringArray(value: unknown): readonly string[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) {
    throw new Error("string array value is required");
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || !entry.trim()) {
      throw new Error("string array value is required");
    }
    return entry.trim();
  });
}

function readSteeringAttachments(value: unknown): readonly SteeringAttachmentReference[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error("attachments must be an array");
  }

  return value.map((entry) => {
    const body = parsePublicBody(entry);
    return {
      key: readRequiredBodyString(body, "key"),
      bucket: readOptionalBodyString(body.bucket),
      fileName: readOptionalBodyString(body.fileName),
      contentType: readOptionalBodyString(body.contentType),
    };
  });
}

function respondPublicException(response: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);

  if (/UNIQUE constraint failed/i.test(message)) {
    response.status(409).json(publicError("conflict", "resource already exists"));
    return;
  }
  if (/FOREIGN KEY constraint failed/i.test(message) || /^project not found:/i.test(message)) {
    response.status(404).json(publicError("not_found", "referenced resource was not found"));
    return;
  }

  response.status(400).json(publicError("validation_error", message));
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
    readonly snapshot: boolean;
    readonly deleteSnapshot: boolean;
    readonly startFromSnapshot: boolean;
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
      capabilities: e2bCapabilities(),
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
        snapshot: false,
        deleteSnapshot: false,
        startFromSnapshot: false,
      },
      requirements: {},
    },
  ];
}

function e2bCapabilities(): {
  readonly start: true;
  readonly stop: true;
  readonly suspend: false;
  readonly resume: false;
  readonly fork: false;
  readonly snapshot: true;
  readonly deleteSnapshot: true;
  readonly startFromSnapshot: true;
} {
  return {
    start: true,
    stop: true,
    suspend: false,
    resume: false,
    fork: false,
    snapshot: true,
    deleteSnapshot: true,
    startFromSnapshot: true,
  };
}

function startStopCapabilities(): {
  readonly start: true;
  readonly stop: true;
  readonly suspend: false;
  readonly resume: false;
  readonly fork: false;
  readonly snapshot: false;
  readonly deleteSnapshot: false;
  readonly startFromSnapshot: false;
} {
  return {
    start: true,
    stop: true,
    suspend: false,
    resume: false,
    fork: false,
    snapshot: false,
    deleteSnapshot: false,
    startFromSnapshot: false,
  };
}
