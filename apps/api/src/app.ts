import express, { type Express, type Request, type Response, type NextFunction } from "express";

import { verifyServiceTokenValue } from "@agent-pool/auth";
import { type AppConfig, loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";
import { SHARED_PACKAGE_NAME } from "@agent-pool/shared";
import { createStorageAdapter, type StorageAdapter } from "@agent-pool/storage";

import { createApiBackendServices } from "./backend-services";
import type { ApiDatabaseConnection } from "./database";
import { createGitHubAppTokenBroker, type GitHubTokenBroker } from "./github-token-broker";
import { createOutboxPublisher, type OutboxPublisher } from "./outbox-publisher";
import type { OutboxPublisherLoop } from "./outbox-publisher-loop";
import { registerPublicApiRoutes, type PublicSseHub } from "./public-api";
import {
  isSmokeFixtureEnabled,
  isSmokeFixtureValidationError,
  readSmokeFixtureStatus,
  seedSmokeFixture,
  type SmokeRuntimeSourceInput,
} from "./smoke-fixture";

type ApiBackendServices = ReturnType<typeof createApiBackendServices>;

export type ApiAppOptions = {
  readonly config?: AppConfig;
  readonly database?: ApiDatabaseConnection;
  readonly queue?: RabbitMqAdapter;
  readonly storage?: StorageAdapter;
  readonly publicSseHub?: PublicSseHub;
  readonly outboxPublisher?: OutboxPublisher;
  readonly outboxPublisherLoop?: OutboxPublisherLoop;
  readonly githubTokenBroker?: GitHubTokenBroker | null;
};

export function createApiApp(options: ApiAppOptions = {}): Express {
  const config = options.config ?? loadConfig();
  const database = options.database;
  const queue = options.queue ?? createRabbitMqAdapter(config.rabbitmq);
  const storage = options.storage ?? createStorageAdapter(config.storage);
  const outboxPublisher = options.outboxPublisher ?? (database ? createOutboxPublisher({ database, queue }) : null);
  const outboxPublisherLoop = options.outboxPublisherLoop ?? null;
  const githubTokenBroker =
    options.githubTokenBroker === undefined
      ? createGitHubAppTokenBroker({ config: config.githubApp })
      : options.githubTokenBroker;
  const services = database ? createApiBackendServices({ database, queue }) : null;
  const app = express();
  const requireInternalServiceToken = createInternalServiceTokenMiddleware(config);

  app.use(express.json());
  registerPublicApiRoutes(app, { config, services, storage, sseHub: options.publicSseHub });

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
        outboxPublisher: {
          initialized: Boolean(outboxPublisher),
          queuedOutbox: database ? countOutboxRows(database, "queued") : 0,
          publishedOutbox: database ? countOutboxRows(database, "published") : 0,
          failedOutbox: database ? countOutboxRows(database, "failed") : 0,
          loop: readOutboxPublisherLoopHealth(outboxPublisherLoop),
        },
        storage: {
          kind: storage.kind,
          bucket: storage.bucket,
        },
      },
      controlPlane: {
        smokeEnabled: config.controlPlane.smokeEnabled,
        smokeProjectId: config.controlPlane.smokeProjectId,
        runtimeProvider: config.controlPlane.runtimeProvider,
        outboxPublishIntervalMs: config.controlPlane.outboxPublishIntervalMs,
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
        outboxPublisher: {
          initialized: Boolean(outboxPublisher),
          loop: readOutboxPublisherLoopHealth(outboxPublisherLoop),
        },
        storage: storage.kind,
      },
      controlPlane: {
        smokeEnabled: config.controlPlane.smokeEnabled,
        smokeProjectId: config.controlPlane.smokeProjectId,
        runtimeProvider: config.controlPlane.runtimeProvider,
      },
    });
  });

  app.post("/internal/smoke/seed", requireInternalServiceToken, async (request, response) => {
    if (!services || !database) {
      response.status(503).json({ ok: false, error: "database_unavailable" });
      return;
    }
    if (!isSmokeFixtureEnabled(config)) {
      response.status(404).json({ ok: false, error: "smoke_disabled" });
      return;
    }

    let runtimeSource: SmokeRuntimeSourceInput | null;
    let forceUnsafeRepository = false;
    try {
      runtimeSource = readSmokeRuntimeSource(request.body);
      forceUnsafeRepository = readSmokeForceUnsafeRepository(request.body);
    } catch (error) {
      response.status(400).json({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    let result;
    try {
      result = await seedSmokeFixture({ config, database, queue, services, runtimeSource, forceUnsafeRepository });
    } catch (error) {
      if (isSmokeFixtureValidationError(error)) {
        response.status(400).json({ ok: false, error: error.message });
        return;
      }
      throw error;
    }
    response.status(200).json({ ok: true, ...result });
  });

  app.get("/internal/smoke/status", requireInternalServiceToken, (_request, response) => {
    if (!database) {
      response.status(503).json({ ok: false, error: "database_unavailable" });
      return;
    }
    if (!isSmokeFixtureEnabled(config)) {
      response.status(404).json({ ok: false, error: "smoke_disabled" });
      return;
    }

    response.status(200).json({ ok: true, ...readSmokeFixtureStatus({ config, database }) });
  });

  app.post("/internal/orchestrator/tasks/claim-next", requireInternalServiceToken, (request, response) => {
    if (!services) {
      response.status(503).json({ ok: false, error: "database_unavailable" });
      return;
    }

    const body = parseObjectBody(request.body);
    const sourceSnapshotId = readOptionalString(body.sourceSnapshotId);
    let result;
    try {
      result = services.claimNextTask({
        projectId: readOptionalString(body.projectId),
        sessionId: readOptionalString(body.sessionId),
        sourceSnapshotId,
        runtimeProvider: readOptionalString(body.runtimeProvider),
        bridgeCallbackBaseUrl: config.bridge.callbackBaseUrl,
        bridgeSessionTokenHeaderName: config.bridge.sessionTokenHeaderName,
      });
    } catch (error) {
      if (!sourceSnapshotId) throw error;
      response.status(409).json({ ok: false, error: { code: "invalid_source_snapshot", message: errorMessage(error) } });
      return;
    }

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
  app.post("/internal/orchestrator/sessions/:sessionId/heartbeat", requireInternalServiceToken, (request, response) => {
    respondWithSessionHeartbeat(response, services, request);
  });
  app.post("/internal/orchestrator/sessions/:sessionId/github-token", requireInternalServiceToken, async (request, response) => {
    await respondWithGitHubSessionToken(response, { database, broker: githubTokenBroker, config }, request);
  });
  app.post("/internal/orchestrator/github-app/verify", requireInternalServiceToken, async (request, response) => {
    await respondWithGitHubAppVerification(response, { broker: githubTokenBroker }, request);
  });
  app.post("/internal/egress/authorize", requireInternalServiceToken, (request, response) => {
    respondWithEgressAuthorization(response, { database, config }, request);
  });
  app.post("/internal/egress/report", requireInternalServiceToken, (request, response) => {
    respondWithEgressReport(response, { database, services }, request);
  });
  app.post("/internal/packages/authorize", requireInternalServiceToken, (request, response) => {
    respondWithPackageRegistryAuthorization(response, { database, services, config }, request);
  });
  app.post("/internal/packages/report", requireInternalServiceToken, (request, response) => {
    respondWithPackageRegistryReport(response, { database, services }, request);
  });
  app.post("/internal/orchestrator/reconcile", requireInternalServiceToken, (request, response) => {
    respondWithReconcile(response, services, request);
  });
  app.post("/internal/orchestrator/runtime-sandboxes/claim-finalization", requireInternalServiceToken, (request, response) => {
    respondWithRuntimeSandboxFinalizationClaim(response, services, request);
  });
  app.post("/internal/orchestrator/runtime-sandboxes/:runtimeSandboxId/snapshot-created", requireInternalServiceToken, (request, response) => {
    respondWithRuntimeSandboxSnapshotReport(response, services, request, "created");
  });
  app.post("/internal/orchestrator/runtime-sandboxes/:runtimeSandboxId/snapshot-failed", requireInternalServiceToken, (request, response) => {
    respondWithRuntimeSandboxSnapshotReport(response, services, request, "failed");
  });
  app.post("/internal/orchestrator/runtime-sandboxes/:runtimeSandboxId/cleanup-succeeded", requireInternalServiceToken, (request, response) => {
    respondWithRuntimeSandboxCleanupReport(response, services, request, "succeeded");
  });
  app.post("/internal/orchestrator/runtime-sandboxes/:runtimeSandboxId/cleanup-failed", requireInternalServiceToken, (request, response) => {
    respondWithRuntimeSandboxCleanupReport(response, services, request, "failed");
  });
  app.post("/internal/orchestrator/snapshots/claim-expired", requireInternalServiceToken, (request, response) => {
    respondWithExpiredSnapshotDeletionClaim(response, services, request);
  });
  app.post("/internal/orchestrator/snapshots/:snapshotId/deleted", requireInternalServiceToken, (request, response) => {
    respondWithExpiredSnapshotDeletionReport(response, services, request, "deleted");
  });
  app.post("/internal/orchestrator/snapshots/:snapshotId/delete-failed", requireInternalServiceToken, (request, response) => {
    respondWithExpiredSnapshotDeletionReport(response, services, request, "failed");
  });
  app.post("/callbacks/:kind", (request, response) => {
    respondWithBridgeCallback(response, services, request);
  });
  app.post("/steering/poll", (request, response) => {
    respondWithBridgeSteeringPoll(response, services, request);
  });
  app.post("/steering/report", (request, response) => {
    respondWithBridgeSteeringReport(response, services, request);
  });

  app.get("/metrics", (_request, response) => {
    const loopState = outboxPublisherLoop?.state;
    response
      .status(200)
      .type("text/plain")
      .send(
        `# metrics placeholder for agent-pool-api\nagent_pool_api_info{shared_package="${SHARED_PACKAGE_NAME}"} 1\nagent_pool_api_database_connected ${database ? 1 : 0}\nagent_pool_api_database_applied_migrations ${database?.appliedMigrations.length ?? 0}\nagent_pool_api_queue_adapter_initialized 1\nagent_pool_api_outbox_publisher_initialized ${outboxPublisher ? 1 : 0}\nagent_pool_api_outbox_queued ${database ? countOutboxRows(database, "queued") : 0}\nagent_pool_api_outbox_published ${database ? countOutboxRows(database, "published") : 0}\nagent_pool_api_outbox_failed ${database ? countOutboxRows(database, "failed") : 0}\nagent_pool_api_outbox_loop_running ${loopState?.running ? 1 : 0}\nagent_pool_api_outbox_loop_in_flight ${loopState?.inFlight ? 1 : 0}\nagent_pool_api_outbox_loop_ticks_total ${loopState?.ticks ?? 0}\nagent_pool_api_outbox_loop_failures_total ${loopState?.failures ?? 0}\nagent_pool_api_storage_adapter_initialized 1\n`,
      );
  });

  return app;
}

function readOutboxPublisherLoopHealth(loop: OutboxPublisherLoop | null) {
  const state = loop?.state;

  return {
    initialized: Boolean(loop),
    running: state?.running ?? false,
    inFlight: state?.inFlight ?? false,
    ticks: state?.ticks ?? 0,
    failures: state?.failures ?? 0,
    lastScanned: state?.lastResult?.scanned ?? null,
    lastPublished: state?.lastResult?.published.length ?? null,
    lastFailed: state?.lastResult?.failed.length ?? null,
    lastError: state?.lastError ?? null,
  };
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

function readSmokeRuntimeSource(body: unknown): SmokeRuntimeSourceInput | null {
  const record = readOptionalRecord(body);
  const value = record?.runtimeSource;
  if (value === undefined || value === null) return null;

  const runtimeSource = readOptionalRecord(value);
  if (!runtimeSource) {
    throw new Error("runtimeSource must be an object");
  }

  return {
    repositoryUrl: readRequiredString(runtimeSource, "repositoryUrl", "runtimeSource"),
    baseRef: readRequiredString(runtimeSource, "baseRef", "runtimeSource"),
    taskBranchPrefix: readRequiredString(runtimeSource, "taskBranchPrefix", "runtimeSource"),
    allowedEgressDomains: readOptionalRecordStringArray(runtimeSource, "allowedEgressDomains", "runtimeSource"),
    commandProfile: readOptionalRecordString(runtimeSource, "commandProfile", "runtimeSource"),
  };
}

function readSmokeForceUnsafeRepository(body: unknown): boolean {
  const record = readOptionalRecord(body);
  const value = record?.forceUnsafeRepository;
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") {
    throw new Error("forceUnsafeRepository must be a boolean");
  }
  return value;
}

function readOptionalRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}

function readRequiredString(record: Readonly<Record<string, unknown>>, key: string, name: string): string {
  const value = record[key];
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} is missing ${key}`);
  }
  return value.trim();
}

function readOptionalRecordString(record: Readonly<Record<string, unknown>>, key: string, name: string): string | null {
  const value = record[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    throw new Error(`${name}.${key} must be a string`);
  }
  return value.trim() || null;
}

function readOptionalRecordStringArray(record: Readonly<Record<string, unknown>>, key: string, name: string): readonly string[] | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value) || value.some((item) => typeof item !== "string" || !item.trim())) {
    throw new Error(`${name}.${key} must be an array of strings`);
  }
  return value.map((item) => item.trim());
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
  services: ApiBackendServices | null,
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
  services: ApiBackendServices | null,
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

function respondWithSessionHeartbeat(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
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

  const result = services.reportSessionHeartbeat({
    projectId,
    sessionId,
    observedAt: readOptionalString(body.observedAt),
  });

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    session: result.session,
    event: result.event,
    outbox: result.outbox,
  });
}

async function respondWithGitHubSessionToken(
  response: Response,
  options: {
    readonly database?: ApiDatabaseConnection;
    readonly broker: GitHubTokenBroker | null;
    readonly config: AppConfig;
  },
  request: Request,
): Promise<void> {
  if (!options.database) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }
  if (!options.broker) {
    response.status(503).json({ ok: false, error: "github_token_broker_unavailable" });
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

  const runtimeSource = readSessionRuntimeSource(options.database, projectId, sessionId);
  if (!runtimeSource) {
    response.status(404).json({ ok: false, error: "session_runtime_source_not_found" });
    return;
  }

  const result = await options.broker.mintInstallationToken({
    repositoryUrl: runtimeSource.repositoryUrl,
  });

  if (!result.ok) {
    response.status(result.status).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    token: {
      envName: options.config.githubApp.tokenEnvName,
      value: result.token.value,
      expiresAt: result.token.expiresAt,
      repositoryUrl: result.token.repositoryUrl,
    },
  });
}

async function respondWithGitHubAppVerification(
  response: Response,
  options: {
    readonly broker: GitHubTokenBroker | null;
  },
  request: Request,
): Promise<void> {
  if (!options.broker?.verifyInstallationAccess) {
    response.status(503).json({ ok: false, error: "github_token_broker_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const repositoryUrl = readOptionalString(body.repositoryUrl);
  if (!repositoryUrl) {
    response.status(400).json({ ok: false, error: "missing_repository_url" });
    return;
  }

  const result = await options.broker.verifyInstallationAccess({ repositoryUrl });
  if (!result.ok) {
    response.status(result.status).json({
      ok: false,
      error: result.error,
      ...(result.repositoryUrl ? { repositoryUrl: result.repositoryUrl } : {}),
      ...(result.missingPermissions?.length ? { missingPermissions: result.missingPermissions } : {}),
    });
    return;
  }

  response.status(200).json({
    ok: true,
    repositoryUrl: result.repositoryUrl,
    token: result.token,
    permissions: result.permissions,
  });
}

function respondWithEgressAuthorization(
  response: Response,
  options: {
    readonly database?: ApiDatabaseConnection;
    readonly config: AppConfig;
  },
  request: Request,
): void {
  if (!options.database) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  const sessionId = readOptionalString(body.sessionId);
  const proxyToken = readOptionalString(body.proxyToken);
  const host = normalizeHost(readOptionalString(body.host));
  if (!projectId || !sessionId || !proxyToken || !host) {
    response.status(400).json({ ok: false, error: "invalid_egress_authorization_request" });
    return;
  }

  const runtimeSource = readSessionRuntimeSource(options.database, projectId, sessionId);
  if (!runtimeSource) {
    response.status(404).json({ ok: false, error: "session_runtime_source_not_found" });
    return;
  }
  if (proxyToken !== runtimeSource.sessionToken) {
    response.status(403).json({ ok: false, allowed: false, reason: "invalid_proxy_token" });
    return;
  }

  const globallyAllowed = options.config.controlPlane.e2b.allowedEgressDomains.includes(host);
  const sessionAllowed = runtimeSource.allowedEgressDomains.includes(host);
  response.status(200).json({
    ok: true,
    allowed: globallyAllowed && sessionAllowed,
    reason: globallyAllowed ? (sessionAllowed ? "allowed" : "not_declared_for_session") : "not_globally_allowed",
    taskId: runtimeSource.taskId,
  });
}

function respondWithEgressReport(
  response: Response,
  options: {
    readonly database?: ApiDatabaseConnection;
    readonly services: ApiBackendServices | null;
  },
  request: Request,
): void {
  if (!options.database || !options.services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  const sessionId = readOptionalString(body.sessionId);
  const proxyToken = readOptionalString(body.proxyToken);
  const host = normalizeHost(readOptionalString(body.host));
  const reason = readOptionalString(body.reason) ?? "unknown";
  const method = readOptionalString(body.method) ?? "CONNECT";
  const allowed = body.allowed === true;
  if (!projectId || !sessionId || !proxyToken || !host) {
    response.status(400).json({ ok: false, error: "invalid_egress_report_request" });
    return;
  }

  const runtimeSource = readSessionRuntimeSource(options.database, projectId, sessionId);
  if (!runtimeSource) {
    response.status(404).json({ ok: false, error: "session_runtime_source_not_found" });
    return;
  }
  if (proxyToken !== runtimeSource.sessionToken) {
    response.status(403).json({ ok: false, error: "invalid_proxy_token" });
    return;
  }

  const stream = "system" as const;
  const sequence = nextOutputSequence(options.database, projectId, runtimeSource.taskId, sessionId, stream);
  const byteOffset = currentLogByteOffset(options.database, projectId, runtimeSource.taskId, sessionId, stream);
  const text = `${JSON.stringify({
    type: "security.egress",
    securityKind: "egress",
    host,
    method,
    allowed,
    reason,
  })}\n`;
  const result = options.services.recordSessionOutput({
    projectId,
    taskId: runtimeSource.taskId,
    sessionId,
    stream,
    sequence,
    byteOffset,
    text,
    observedAt: new Date().toISOString(),
  });

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }
  response.status(200).json({ ok: true, output: result.output, event: result.event, outbox: result.outbox });
}

function respondWithPackageRegistryAuthorization(
  response: Response,
  options: {
    readonly database?: ApiDatabaseConnection;
    readonly services: ApiBackendServices | null;
    readonly config: AppConfig;
  },
  request: Request,
): void {
  if (!options.database || !options.services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  const sessionId = readOptionalString(body.sessionId);
  const proxyToken = readOptionalString(body.proxyToken);
  const registryHost = normalizeHost(readOptionalString(body.registryHost) ?? readOptionalString(body.host));
  const packageName = readOptionalString(body.packageName);
  if (!projectId || !sessionId || !proxyToken || !registryHost || !packageName) {
    response.status(400).json({ ok: false, error: "invalid_package_authorization_request" });
    return;
  }

  const runtimeSource = readSessionRuntimeSource(options.database, projectId, sessionId);
  if (!runtimeSource) {
    response.status(404).json({ ok: false, error: "session_runtime_source_not_found" });
    return;
  }
  if (proxyToken !== runtimeSource.sessionToken) {
    response.status(403).json({ ok: false, allowed: false, reason: "invalid_proxy_token" });
    return;
  }

  const result = options.services.authorizePackageRegistryAccess({
    projectId,
    sessionId,
    registryHost,
    packageName,
    ecosystem: readOptionalString(body.ecosystem),
    requestedVersion: readOptionalString(body.requestedVersion),
    resolvedVersion: readOptionalString(body.resolvedVersion),
    globalAllowedRegistryHosts: options.config.controlPlane.e2b.allowedEgressDomains,
    metadata: readOptionalObject(body.metadata),
  });
  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 400).json({ ok: false, error: result.error });
    return;
  }
  const output = recordPackageRegistrySecurityOutput(options.database, options.services, {
    projectId,
    taskId: result.audit.taskId,
    sessionId,
    audit: result.audit,
  });
  response.status(200).json({
    ok: true,
    allowed: result.allowed,
    reason: result.reason,
    audit: result.audit,
    ...(output ? { output: output.output, event: output.event, outbox: output.outbox } : {}),
  });
}

function respondWithPackageRegistryReport(
  response: Response,
  options: {
    readonly database?: ApiDatabaseConnection;
    readonly services: ApiBackendServices | null;
  },
  request: Request,
): void {
  if (!options.database || !options.services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  const sessionId = readOptionalString(body.sessionId);
  const proxyToken = readOptionalString(body.proxyToken);
  const registryHost = normalizeHost(readOptionalString(body.registryHost) ?? readOptionalString(body.host));
  const packageName = readOptionalString(body.packageName);
  const decision = readPackageRegistryDecision(body.decision);
  const reason = readOptionalString(body.reason) ?? (decision === "failed" ? "resolution_failed" : "reported");
  if (!projectId || !sessionId || !proxyToken || !registryHost || !packageName || !decision) {
    response.status(400).json({ ok: false, error: "invalid_package_report_request" });
    return;
  }

  const runtimeSource = readSessionRuntimeSource(options.database, projectId, sessionId);
  if (!runtimeSource) {
    response.status(404).json({ ok: false, error: "session_runtime_source_not_found" });
    return;
  }
  if (proxyToken !== runtimeSource.sessionToken) {
    response.status(403).json({ ok: false, error: "invalid_proxy_token" });
    return;
  }

  const result = options.services.recordPackageRegistryAudit({
    projectId,
    sessionId,
    registryHost,
    packageName,
    ecosystem: readOptionalString(body.ecosystem),
    requestedVersion: readOptionalString(body.requestedVersion),
    resolvedVersion: readOptionalString(body.resolvedVersion),
    decision,
    reason,
    metadata: readOptionalObject(body.metadata),
  });
  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 400).json({ ok: false, error: result.error });
    return;
  }
  const output = recordPackageRegistrySecurityOutput(options.database, options.services, {
    projectId,
    taskId: result.audit.taskId,
    sessionId,
    audit: result.audit,
  });
  response.status(200).json({ ok: true, audit: result.audit, ...(output ? { output: output.output, event: output.event, outbox: output.outbox } : {}) });
}

function respondWithReconcile(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const staleBefore = readOptionalString(body.staleBefore);
  const lostBefore = readOptionalString(body.lostBefore);
  if (!staleBefore || !lostBefore) {
    response.status(400).json({ ok: false, error: "missing_reconcile_thresholds" });
    return;
  }

  const result = services.reconcileLostSessions({
    projectId: readOptionalString(body.projectId),
    staleBefore,
    lostBefore,
    now: readOptionalString(body.now),
  });

  response.status(200).json({
    ok: true,
    stale: result.stale,
    lost: result.lost,
    events: result.events,
    outbox: result.outbox,
  });
}

function respondWithRuntimeSandboxFinalizationClaim(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const result = services.claimNextRuntimeSandboxFinalization({
    projectId: readOptionalString(body.projectId),
    cleanupGraceBefore: readOptionalString(body.cleanupGraceBefore),
  });

  if (!result.ok) {
    response.status(200).json({ ok: true, claimed: false, reason: result.reason });
    return;
  }

  response.status(200).json({
    ok: true,
    claimed: true,
    finalization: result.finalization,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithRuntimeSandboxSnapshotReport(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
  report: "created" | "failed",
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const runtimeSandboxId = request.params?.runtimeSandboxId;
  if (!runtimeSandboxId) {
    response.status(400).json({ ok: false, error: "missing_runtime_sandbox_id" });
    return;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  if (!projectId) {
    response.status(400).json({ ok: false, error: "missing_project_id" });
    return;
  }

  const result =
    report === "created"
      ? services.reportRuntimeSandboxSnapshotCreated({
          projectId,
          runtimeSandboxId,
          providerSnapshotId: readOptionalString(body.providerSnapshotId) ?? "",
          expiresAt: readOptionalString(body.expiresAt),
          metadata: readOptionalObject(body.metadata),
        })
      : services.reportRuntimeSandboxSnapshotFailed({
          projectId,
          runtimeSandboxId,
          errorMessage: readOptionalString(body.errorMessage) ?? "snapshot failed without details",
        });

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    snapshot: result.snapshot,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithRuntimeSandboxCleanupReport(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
  report: "succeeded" | "failed",
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const runtimeSandboxId = request.params?.runtimeSandboxId;
  if (!runtimeSandboxId) {
    response.status(400).json({ ok: false, error: "missing_runtime_sandbox_id" });
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
    runtimeSandboxId,
    errorMessage: readOptionalString(body.errorMessage),
  };
  const result =
    report === "succeeded"
      ? services.reportRuntimeSandboxCleanupSucceeded(input)
      : services.reportRuntimeSandboxCleanupFailed(input);

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    runtimeSandbox: result.runtimeSandbox,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithExpiredSnapshotDeletionClaim(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const body = parseObjectBody(request.body);
  const result = services.claimNextExpiredSnapshotDeletion({
    projectId: readOptionalString(body.projectId),
    now: readOptionalString(body.now),
  });

  if (!result.ok) {
    response.status(200).json({ ok: true, claimed: false, reason: result.reason });
    return;
  }

  response.status(200).json({
    ok: true,
    claimed: true,
    snapshot: result.snapshot,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithExpiredSnapshotDeletionReport(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
  report: "deleted" | "failed",
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const snapshotId = request.params?.snapshotId;
  if (!snapshotId) {
    response.status(400).json({ ok: false, error: "missing_snapshot_id" });
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
    snapshotId,
    errorMessage: readOptionalString(body.errorMessage),
  };
  const result =
    report === "deleted"
      ? services.reportExpiredSnapshotDeletionSucceeded(input)
      : services.reportExpiredSnapshotDeletionFailed(input);

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    idempotent: result.idempotent,
    snapshot: result.snapshot,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithBridgeCallback(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
): void {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return;
  }

  const kind = readBridgeCallbackKind(request.params?.kind);
  if (!kind) {
    response.status(404).json({ ok: false, error: "unsupported_bridge_callback" });
    return;
  }

  const body = parseObjectBody(request.body);
  if (body.kind !== kind) {
    response.status(400).json({ ok: false, error: "invalid_callback_kind" });
    return;
  }

  const projectId = readOptionalString(body.projectId);
  const taskId = readOptionalString(body.taskId);
  const sessionId = readOptionalString(body.sessionId);
  if (!projectId || !taskId || !sessionId) {
    response.status(400).json({ ok: false, error: "missing_callback_scope" });
    return;
  }

  const bridge = services.readBridgeSessionCallbackConfig({ projectId, taskId, sessionId });
  if (!bridge.ok) {
    response.status(bridge.error.code === "not_found" ? 404 : 409).json({ ok: false, error: bridge.error });
    return;
  }

  const token = readHeader(request, bridge.bridge.sessionToken.headerName);
  if (!token) {
    response.status(401).json({ ok: false, error: "invalid_session_token", reason: "missing" });
    return;
  }
  if (token !== bridge.bridge.sessionToken.token) {
    response.status(403).json({ ok: false, error: "invalid_session_token", reason: "invalid" });
    return;
  }

  if (kind === "heartbeat") {
    const result = services.reportSessionHeartbeat({
      projectId,
      sessionId,
      observedAt: readOptionalString(body.observedAt),
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      session: result.session,
      event: result.event,
      outbox: result.outbox,
    });
    return;
  }

  if (kind === "document") {
    const path = readOptionalString(body.path);
    if (!path) {
      response.status(400).json({ ok: false, error: "invalid_document_callback" });
      return;
    }

    const sizeBytes = body.sizeBytes === undefined ? undefined : readInteger(body.sizeBytes);
    if (body.sizeBytes !== undefined && (sizeBytes === undefined || sizeBytes < 0)) {
      response.status(400).json({ ok: false, error: "invalid_document_callback" });
      return;
    }

    const result = services.recordDocumentArtifact({
      projectId,
      taskId,
      sessionId,
      path,
      title: readOptionalString(body.title),
      contentType: readOptionalString(body.contentType),
      sizeBytes,
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      artifact: result.artifact,
      event: result.event,
      outbox: result.outbox,
      idempotent: result.idempotent,
    });
    return;
  }

  if (kind === "final_response") {
    const text = typeof body.text === "string" ? body.text : undefined;
    if (text === undefined) {
      response.status(400).json({ ok: false, error: "invalid_final_response_callback" });
      return;
    }

    const result = services.recordFinalAssistantResponse({
      projectId,
      sessionId,
      text,
      metadata: readOptionalObject(body.metadata),
      urlCandidates: readStringArray(body.urlCandidates),
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      event: result.event,
      artifacts: result.artifacts,
    });
    return;
  }

  if (kind === "completion") {
    const result = services.completeSession({
      projectId,
      taskId,
      sessionId,
      observedAt: readOptionalString(body.observedAt),
      metadata: readOptionalObject(body.metadata),
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      idempotent: result.idempotent,
      session: result.session,
      task: result.task,
      event: result.event,
      outbox: result.outbox,
    });
    return;
  }

  if (kind === "failure") {
    const errorMessage = readOptionalString(body.errorMessage);
    if (!errorMessage) {
      response.status(400).json({ ok: false, error: "invalid_failure_callback" });
      return;
    }

    const result = services.failSession({
      projectId,
      taskId,
      sessionId,
      errorMessage,
      observedAt: readOptionalString(body.observedAt),
      metadata: readOptionalObject(body.metadata),
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      idempotent: result.idempotent,
      session: result.session,
      task: result.task,
      event: result.event,
      outbox: result.outbox,
    });
    return;
  }

  if (kind === "cleanup") {
    const result = services.cleanupSession({
      projectId,
      taskId,
      sessionId,
      reason: readOptionalString(body.reason),
      observedAt: readOptionalString(body.observedAt),
      metadata: readOptionalObject(body.metadata),
    });

    if (!result.ok) {
      response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
      return;
    }

    response.status(200).json({
      ok: true,
      idempotent: result.idempotent,
      event: result.event,
      outbox: result.outbox,
    });
    return;
  }

  const stream = readBridgeOutputStream(body.stream);
  const sequence = readInteger(body.sequence);
  const byteOffset = readInteger(body.byteOffset);
  const text = typeof body.text === "string" ? body.text : undefined;
  if (!stream || sequence === undefined || sequence < 1 || byteOffset === undefined || byteOffset < 0 || text === undefined) {
    response.status(400).json({ ok: false, error: "invalid_output_callback" });
    return;
  }

  const result = services.recordSessionOutput({
    projectId,
    taskId,
    sessionId,
    stream,
    sequence,
    byteOffset,
    text,
    observedAt: readOptionalString(body.observedAt),
  });

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    output: result.output,
    event: result.event,
    outbox: result.outbox,
  });
}

function respondWithBridgeSteeringPoll(response: Response, services: ApiBackendServices | null, request: Request): void {
  const scope = readValidatedBridgeScope(response, services, request);
  if (!scope || !services) return;

  const result = services.pollQueuedSteering(scope);
  if (!result.ok) {
    response.status(404).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    messages: result.messages.map((message) => ({
      id: message.id,
      body: message.body,
      commandId: message.commandId,
      confirmedInterrupt: message.confirmedInterrupt,
      metadata: message.metadata ?? { attachments: message.attachments },
    })),
  });
}

function respondWithBridgeSteeringReport(response: Response, services: ApiBackendServices | null, request: Request): void {
  const scope = readValidatedBridgeScope(response, services, request);
  if (!scope || !services) return;

  const body = parseObjectBody(request.body);
  const steeringMessageId = readOptionalString(body.steeringMessageId);
  const status = readSteeringReportStatus(body.status);

  if (!steeringMessageId || !status) {
    response.status(400).json({ ok: false, error: "invalid_steering_report" });
    return;
  }

  const result = services.reportSteeringDelivery({
    ...scope,
    steeringMessageId,
    status,
    errorMessage: readOptionalString(body.errorMessage),
  });

  if (!result.ok) {
    response.status(result.error.code === "not_found" ? 404 : 409).json({ ok: false, error: result.error });
    return;
  }

  response.status(200).json({
    ok: true,
    steering: result.steering,
    event: result.event,
    outbox: result.outbox,
    idempotent: result.idempotent,
  });
}

function readValidatedBridgeScope(
  response: Response,
  services: ApiBackendServices | null,
  request: Request,
): { readonly projectId: string; readonly taskId: string; readonly sessionId: string } | null {
  if (!services) {
    response.status(503).json({ ok: false, error: "database_unavailable" });
    return null;
  }

  const body = parseObjectBody(request.body);
  const projectId = readOptionalString(body.projectId);
  const taskId = readOptionalString(body.taskId);
  const sessionId = readOptionalString(body.sessionId);
  if (!projectId || !taskId || !sessionId) {
    response.status(400).json({ ok: false, error: "missing_callback_scope" });
    return null;
  }

  const bridge = services.readBridgeSessionCallbackConfig({ projectId, taskId, sessionId });
  if (!bridge.ok) {
    response.status(bridge.error.code === "not_found" ? 404 : 409).json({ ok: false, error: bridge.error });
    return null;
  }

  const token = readHeader(request, bridge.bridge.sessionToken.headerName);
  if (!token) {
    response.status(401).json({ ok: false, error: "invalid_session_token", reason: "missing" });
    return null;
  }
  if (token !== bridge.bridge.sessionToken.token) {
    response.status(403).json({ ok: false, error: "invalid_session_token", reason: "invalid" });
    return null;
  }

  return { projectId, taskId, sessionId };
}

function parseObjectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readSteeringReportStatus(value: unknown): "delivered" | "failed" | undefined {
  return value === "delivered" || value === "failed" ? value : undefined;
}

function readHeader(request: Request, name: string): string | undefined {
  const value = request.headers?.[name.toLowerCase()];
  const raw = Array.isArray(value) ? value[0] : value;

  return readOptionalString(raw);
}

function readBridgeCallbackKind(
  value: unknown,
): "heartbeat" | "output" | "document" | "final_response" | "completion" | "failure" | "cleanup" | undefined {
  return value === "heartbeat" ||
    value === "output" ||
    value === "document" ||
    value === "final_response" ||
    value === "completion" ||
    value === "failure" ||
    value === "cleanup"
    ? value
    : undefined;
}

function readBridgeOutputStream(value: unknown): "stdout" | "stderr" | "combined" | "system" | undefined {
  return value === "stdout" || value === "stderr" || value === "combined" || value === "system" ? value : undefined;
}

function readPackageRegistryDecision(value: unknown): "allowed" | "denied" | "failed" | undefined {
  return value === "allowed" || value === "denied" || value === "failed" ? value : undefined;
}

function readInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) ? value : undefined;
}

function readOptionalObject(value: unknown): Readonly<Record<string, unknown>> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function readStringArray(value: unknown): readonly string[] | undefined {
  return Array.isArray(value) && value.every((item) => typeof item === "string") ? value : undefined;
}

function readSessionRuntimeSource(
  database: ApiDatabaseConnection,
  projectId: string,
  sessionId: string,
): {
  readonly taskId: string;
  readonly repositoryUrl: string;
  readonly allowedEgressDomains: readonly string[];
  readonly sessionToken: string;
} | null {
  const row = database.sqlite
    .query<{ task_id: string; runtime_source_json: string | null; bridge_session_token: string | null }, [string, string]>(
      `SELECT s.task_id, t.runtime_source_json, s.bridge_session_token
       FROM sessions s
       JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
       WHERE s.project_id = ? AND s.id = ?`,
    )
    .get(projectId, sessionId);

  if (!row?.runtime_source_json) return null;
  try {
    const parsed = JSON.parse(row.runtime_source_json) as Readonly<Record<string, unknown>>;
    const repositoryUrl = readOptionalString(parsed.repositoryUrl);
    const allowedEgressDomains = readStringArray(parsed.allowedEgressDomains)?.map((domain) => domain.toLowerCase()) ?? [];
    return repositoryUrl && row.bridge_session_token
      ? { taskId: row.task_id, repositoryUrl, allowedEgressDomains, sessionToken: row.bridge_session_token }
      : null;
  } catch {
    return null;
  }
}

function recordPackageRegistrySecurityOutput(
  database: ApiDatabaseConnection,
  services: ApiBackendServices,
  input: {
    readonly projectId: string;
    readonly taskId: string;
    readonly sessionId: string;
    readonly audit: {
      readonly ecosystem: string;
      readonly registryHost: string;
      readonly packageName: string;
      readonly requestedVersion: string | null;
      readonly resolvedVersion: string | null;
      readonly decision: "allowed" | "denied" | "failed";
      readonly reason: string;
    };
  },
):
  | {
      readonly output: unknown;
      readonly event: unknown;
      readonly outbox: unknown;
    }
  | null {
  const stream = "system" as const;
  const sequence = nextOutputSequence(database, input.projectId, input.taskId, input.sessionId, stream);
  const byteOffset = currentLogByteOffset(database, input.projectId, input.taskId, input.sessionId, stream);
  const text = `${JSON.stringify({
    type: "security.package",
    securityKind: "package-registry",
    ecosystem: input.audit.ecosystem,
    registryHost: input.audit.registryHost,
    packageName: input.audit.packageName,
    requestedVersion: input.audit.requestedVersion,
    resolvedVersion: input.audit.resolvedVersion,
    decision: input.audit.decision,
    allowed: input.audit.decision === "allowed",
    reason: input.audit.reason,
  })}\n`;
  const result = services.recordSessionOutput({
    projectId: input.projectId,
    taskId: input.taskId,
    sessionId: input.sessionId,
    stream,
    sequence,
    byteOffset,
    text,
    observedAt: new Date().toISOString(),
  });
  return result.ok ? { output: result.output, event: result.event, outbox: result.outbox } : null;
}

function nextOutputSequence(
  database: ApiDatabaseConnection,
  projectId: string,
  taskId: string,
  sessionId: string,
  stream: "stdout" | "stderr" | "combined" | "system",
): number {
  const rows = database.sqlite
    .query<{ payload_json: string }, [string, string, string]>(
      "SELECT payload_json FROM events WHERE project_id = ? AND session_id = ? AND task_id = ? AND type = 'session.output'",
    )
    .all(projectId, sessionId, taskId);
  let max = 0;
  for (const row of rows) {
    const payload = readOptionalObject(JSON.parse(row.payload_json));
    if (payload?.stream === stream && typeof payload.sequence === "number") {
      max = Math.max(max, payload.sequence);
    }
  }
  return max + 1;
}

function currentLogByteOffset(
  database: ApiDatabaseConnection,
  projectId: string,
  taskId: string,
  sessionId: string,
  stream: "stdout" | "stderr" | "combined" | "system",
): number {
  const row = database.sqlite
    .query<{ byte_offset: number }, [string, string, string, string]>(
      "SELECT byte_offset FROM log_streams WHERE project_id = ? AND task_id = ? AND session_id = ? AND kind = ? ORDER BY created_at ASC, id ASC LIMIT 1",
    )
    .get(projectId, taskId, sessionId, stream);
  return row?.byte_offset ?? 0;
}

function normalizeHost(value: string | undefined): string | null {
  if (!value) return null;
  const host = value.toLowerCase().replace(/\.$/, "");
  if (!host || host.includes("/") || host.includes(":") || host.includes("*")) return null;
  if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(host)) return null;
  return host;
}

function countOutboxRows(database: ApiDatabaseConnection, status: "queued" | "published" | "failed"): number {
  const row = database.sqlite.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM outbox WHERE status = ?").get(status);
  return row?.count ?? 0;
}
