import express, { type Express, type Request, type Response, type NextFunction } from "express";

import { verifyServiceTokenValue } from "@agent-pool/auth";
import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { SHARED_PACKAGE_NAME } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

import type { ApiDatabaseConnection } from "./database";

export type ApiAppOptions = {
  readonly config?: AppConfig;
  readonly database?: ApiDatabaseConnection;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
};

export function createApiApp(options: ApiAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const database = options.database;
  const queue = options.queue ?? createRabbitMqAdapter(config.rabbitmq);
  const storage = options.storage ?? createStorageAdapter(config.storage);
  const services = database ? createCanonicalStateServices(database.sqlite) : null;
  const app = express();
  const requireInternalServiceToken = createInternalServiceTokenMiddleware(config);

  app.use(express.json());

  app.get("/health", (_request, response) => {
    response.status(200).json({
      ok: true,
      service: "agent-pool-api",
      authMode: config.authMode,
      database: {
        connected: Boolean(database),
        path: database?.path ?? null,
        appliedMigrations: database?.appliedMigrations.length ?? 0,
      },
      adapters: {
        queue: {
          kind: queue.kind,
          connected: queue.connected,
        },
        storage: {
          kind: storage.kind,
          bucket: storage.bucket,
        },
      },
    });
  });

  app.get("/internal/health", requireInternalServiceToken, (request, response) => {
    response.status(200).json({
      ok: true,
      service: "agent-pool-api",
      subject: request.internalServiceSubject,
      database: {
        connected: Boolean(database),
        appliedMigrations: database?.appliedMigrations.length ?? 0,
      },
      adapters: {
        queue: queue.kind,
        storage: storage.kind,
      },
    });
  });

  app.post("/internal/orchestrator/tasks/claim-next", requireInternalServiceToken, (request, response) => {
    if (!services) {
      response.status(503).json({ ok: false, error: "database_unavailable" });
      return;
    }

    const body = parseObjectBody(request.body);
    const result = services.claimNextTask({
      projectId: readOptionalString(body.projectId),
      sessionId: readOptionalString(body.sessionId),
      runtimeProvider: readOptionalString(body.runtimeProvider),
    });

    if (!result.ok) {
      response.status(200).json({ ok: true, claimed: false, reason: result.reason });
      return;
    }

    response.status(200).json({
      ok: true,
      claimed: true,
      task: result.task,
      session: result.session,
      event: result.event,
      outbox: result.outbox,
    });
  });
  app.post("/internal/orchestrator/commands/claim-next", requireInternalServiceToken, (request, response) => {
    if (!services) {
      response.status(503).json({ ok: false, error: "database_unavailable" });
      return;
    }

    const body = parseObjectBody(request.body);
    const result = services.claimNextCommand({
      projectId: readOptionalString(body.projectId),
    });

    if (!result.ok) {
      response.status(200).json({ ok: true, claimed: false, reason: result.reason });
      return;
    }

    response.status(200).json({
      ok: true,
      claimed: true,
      command: result.command,
      event: result.event,
      outbox: result.outbox,
    });
  });
  app.post("/internal/orchestrator/commands/:commandId/started", requireInternalServiceToken, (request, response) => {
    respondWithCommandReport(response, services, request, "started");
  });
  app.post("/internal/orchestrator/commands/:commandId/succeeded", requireInternalServiceToken, (request, response) => {
    respondWithCommandReport(response, services, request, "succeeded");
  });
  app.post("/internal/orchestrator/commands/:commandId/failed", requireInternalServiceToken, (request, response) => {
    respondWithCommandReport(response, services, request, "failed");
  });
  app.post("/internal/orchestrator/sessions/:sessionId/startup-succeeded", requireInternalServiceToken, (request, response) => {
    respondWithStartupReport(response, services, request, "succeeded");
  });
  app.post("/internal/orchestrator/sessions/:sessionId/startup-failed", requireInternalServiceToken, (request, response) => {
    respondWithStartupReport(response, services, request, "failed");
  });
  app.post("/internal/orchestrator/sessions/:sessionId/heartbeat", requireInternalServiceToken, sendNotImplemented);
  app.post("/internal/orchestrator/reconcile", requireInternalServiceToken, sendNotImplemented);

  app.get("/metrics", (_request, response) => {
    response
      .status(200)
      .type("text/plain")
      .send(
        `# metrics placeholder for agent-pool-api\nagent_pool_api_info{shared_package="${SHARED_PACKAGE_NAME}"} 1\nagent_pool_api_database_connected ${database ? 1 : 0}\nagent_pool_api_database_applied_migrations ${database?.appliedMigrations.length ?? 0}\nagent_pool_api_queue_adapter_initialized 1\nagent_pool_api_storage_adapter_initialized 1\n`,
      );
  });

  return app;
}

type InternalServiceRequest = Request & {
  internalServiceSubject?: "internal-service";
};

declare global {
  namespace Express {
    interface Request {
      internalServiceSubject?: "internal-service";
    }
  }
}

function createInternalServiceTokenMiddleware(config: AppConfig) {
  return (request: InternalServiceRequest, response: Response, next?: NextFunction) => {
    const headers = (request as { headers?: Record<string, string | readonly string[] | undefined> }).headers ?? {};
    const headerValue = headers[config.serviceToken.headerName];
    const auth = verifyServiceTokenValue(Array.isArray(headerValue) ? headerValue[0] : headerValue, config.serviceToken);

    if (!auth.ok) {
      response.status(auth.reason === "missing" ? 401 : 403).json({
        ok: false,
        error: "invalid_internal_service_token",
        reason: auth.reason,
      });
      return;
    }

    request.internalServiceSubject = auth.subject;
    if (!next) {
      throw new Error("internal service token middleware requires a next callback");
    }
    next();
  };
}

function respondWithCommandReport(
  response: Response,
  services: ReturnType<typeof createCanonicalStateServices> | null,
  request: Request,
  report: "started" | "succeeded" | "failed",
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const commandId = request.params?.commandId;
  if (!commandId) {
    response.status(400).json({ ok: false, error: "missing_command_id" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  if (!projectId) {
    response.status(400).json({ ok: false, error: "missing_project_id" });
    return;
  }

  const input = { projectId, commandId, errorMessage: readOptionalString(body.errorMessage) };
  const result =
    report === "started"
      ? services.reportCommandStarted(input)
      : report === "succeeded"
        ? services.reportCommandSucceeded(input)
        : services.reportCommandFailed(input);

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    command: result.command,
    event: result.event ?? null,
    outbox: result.outbox ?? null,
  });
}

function respondWithStartupReport(
  response: Response,
  services: ReturnType<typeof createCanonicalStateServices> | null,
  request: Request,
  report: "succeeded" | "failed",
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const sessionId = request.params?.sessionId;
  if (!sessionId) {
    response.status(400).json({ ok: false, error: "missing_session_id" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  if (!projectId) {
    response.status(400).json({ ok: false, error: "missing_project_id" });
    return;
  }

  const input = {
    projectId,
    sessionId,
    runtimeSessionId: readOptionalString(body.runtimeSessionId),
    errorMessage: readOptionalString(body.errorMessage),
  };
  const result = report === "succeeded" ? services.reportStartupSucceeded(input) : services.reportStartupFailed(input);

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    session: result.session,
    task: result.task,
    event: result.event ?? null,
    outbox: result.outbox ?? null,
  });
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function sendNotImplemented(request: Request, response: Response): void {
  response.status(501).json({
    ok: false,
    error: "internal_orchestrator_endpoint_not_implemented",
    method: request.method,
    path: request.path,
  });
}
