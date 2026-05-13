import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter, type RabbitMqAdapter } from "@agent-pool/queue";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";
import { createOutboxPublisherLoop, type OutboxPublisherLoop } from "../src/outbox-publisher-loop";
import { createPublicSseHub, type PublicSseHub } from "../src/public-api";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API service skeleton", () => {
  test("health reports config and migrated database state", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/health`);
      const body = await response.json();

      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.service).toBe("agent-pool-api");
      expect(body.authMode).toBe("test");
      expect(body.database.connected).toBe(true);
      expect(body.database.path).toEndWith("web-sandbox.db");
      expect(body.database.appliedMigrations).toBeGreaterThan(0);
      expect(body.adapters).toMatchObject({
        queue: { kind: "rabbitmq", connected: false },
        outboxPublisher: {
          initialized: true,
          queuedOutbox: 0,
          publishedOutbox: 0,
          failedOutbox: 0,
          loop: { initialized: false, running: false, inFlight: false, ticks: 0, failures: 0 },
        },
        storage: { kind: "local" },
      });
      expect(body.controlPlane).toMatchObject({
        smokeEnabled: true,
        smokeProjectId: "compose-smoke",
        runtimeProvider: "fake",
        outboxPublishIntervalMs: 1000,
      });
    } finally {
      await close();
    }
  });

  test("internal health requires service-token auth", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/health`);
      const invalid = await fetch(`${baseUrl}/internal/health`, {
        headers: {
          [config.serviceToken.headerName]: "wrong",
        },
      });
      const ok = await fetch(`${baseUrl}/internal/health`, {
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, subject: "internal-service" });
    } finally {
      await close();
    }
  });

  test("public API identity route requires deterministic operator auth", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/api/public/me`);
      const invalid = await fetch(`${baseUrl}/api/public/me`, {
        headers: {
          "x-agent-pool-operator-id": "wrong-operator",
        },
      });
      const ok = await fetch(`${baseUrl}/api/public/me`, {
        headers: {
          "x-agent-pool-operator-id": config.operator.id,
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toEqual({
        ok: false,
        error: { code: "unauthenticated", message: "operator auth required" },
      });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toEqual({
        ok: false,
        error: { code: "forbidden", message: "operator auth invalid" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toEqual({
        ok: true,
        authMode: "test",
        operator: config.operator,
      });
    } finally {
      await close();
    }
  });

  test("local public API requires a signed operator session cookie", async () => {
    const { baseUrl, config, close } = await startTestApi({
      env: {
        AUTH_MODE: "local",
        OPERATOR_ID: "operator-local",
        OPERATOR_EMAIL: "operator@example.test",
        OPERATOR_PASSWORD: "operator-password",
        PUBLIC_AUTH_SESSION_SECRET: "public-auth-session-secret-123456",
        INTERNAL_SERVICE_TOKEN: "internal-service-token",
      },
    });

    try {
      const headerOnly = await fetch(`${baseUrl}/api/public/me`, {
        headers: { "x-agent-pool-operator-id": config.operator.id },
      });
      const badLogin = await fetch(`${baseUrl}/api/public/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: config.operator.id, password: "wrong-password" }),
      });
      const login = await fetch(`${baseUrl}/api/public/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ operatorId: config.operator.id, password: config.publicAuth.operatorPassword }),
      });
      const setCookie = login.headers.get("set-cookie") ?? "";
      const sessionCookie = setCookie.split(";")[0];
      const cookieOnly = await fetch(`${baseUrl}/api/public/me`, {
        headers: { cookie: sessionCookie },
      });
      const ok = await fetch(`${baseUrl}/api/public/me`, {
        headers: {
          cookie: sessionCookie,
          "x-agent-pool-operator-id": config.operator.id,
        },
      });
      const logout = await fetch(`${baseUrl}/api/public/auth/logout`, { method: "POST" });

      expect(headerOnly.status).toBe(401);
      expect(await headerOnly.json()).toEqual({
        ok: false,
        error: { code: "unauthenticated", message: "operator session required" },
      });
      expect(badLogin.status).toBe(401);
      expect(await badLogin.json()).toEqual({
        ok: false,
        error: { code: "invalid_credentials", message: "operator credentials are invalid" },
      });
      expect(badLogin.headers.get("set-cookie")).toBeNull();
      expect(login.status).toBe(200);
      expect(await login.json()).toMatchObject({
        ok: true,
        authMode: "local",
        operator: config.operator,
      });
      expect(setCookie).toContain(`${config.publicAuth.cookieName}=`);
      expect(setCookie).toContain("HttpOnly");
      expect(setCookie).toContain("SameSite=Strict");
      expect(setCookie).toContain("Path=/api/public");
      expect(setCookie).not.toContain(config.publicAuth.operatorPassword ?? "operator-password");
      expect(cookieOnly.status).toBe(403);
      expect(await cookieOnly.json()).toEqual({
        ok: false,
        error: { code: "forbidden", message: "operator session identity mismatch" },
      });
      expect(ok.status).toBe(200);
      expect(await ok.json()).toMatchObject({ ok: true, authMode: "local", operator: config.operator });
      expect(logout.status).toBe(200);
      expect(logout.headers.get("set-cookie")).toContain("Max-Age=0");
    } finally {
      await close();
    }
  });

  test("public project and task routes expose authenticated read and mutation models", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const unauthenticated = await fetch(`${baseUrl}/api/public/projects`);
      expect(unauthenticated.status).toBe(401);

      const createdProject = await postPublic(baseUrl, config, "/projects", {
        slug: "public-project",
        name: "Public Project",
        description: "Visible through public API",
      });
      const createdProjectBody = await createdProject.json();
      const projectId = createdProjectBody.project.id;
      expect(createdProject.status).toBe(201);
      expect(createdProjectBody).toMatchObject({
        ok: true,
        project: { id: expect.any(String), slug: "public-project", name: "Public Project" },
        queues: expect.any(Array),
      });

      const lowTask = await postPublic(baseUrl, config, `/projects/${projectId}/tasks`, {
        title: "Low priority",
        priority: 1,
      });
      const highTask = await postPublic(baseUrl, config, `/projects/${projectId}/tasks`, {
        title: "High priority",
        priority: 5,
      });
      const lowTaskBody = await lowTask.json();
      const highTaskBody = await highTask.json();
      expect(lowTaskBody).toMatchObject({ ok: true });
      expect(lowTask.status).toBe(201);
      expect(highTask.status).toBe(201);
      expect(highTaskBody.task).toMatchObject({ title: "High priority", priority: 5 });

      const tasks = await fetch(`${baseUrl}/api/public/projects/${projectId}/tasks`, {
        headers: publicHeaders(config),
      });
      const tasksBody = await tasks.json();
      expect(tasks.status).toBe(200);
      expect(tasksBody.tasks.map((task: { id: string; priority: number }) => ({ id: task.id, priority: task.priority }))).toEqual([
        { id: highTaskBody.task.id, priority: 5 },
        { id: lowTaskBody.task.id, priority: 1 },
      ]);

      const priority = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${lowTaskBody.task.id}/priority`, {
        priority: 10,
      });
      const priorityBody = await priority.json();
      expect(priority.status).toBe(200);
      expect(priorityBody).toMatchObject({
        ok: true,
        idempotent: false,
        task: { id: lowTaskBody.task.id, priority: 10 },
        event: { type: "task.priority_updated" },
      });

      database.sqlite
        .query("UPDATE tasks SET status = 'blocked' WHERE project_id = ? AND id = ?")
        .run(projectId, lowTaskBody.task.id);
      const unblock = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${lowTaskBody.task.id}/unblock`, {});
      const unblockBody = await unblock.json();
      expect(unblock.status).toBe(200);
      expect(unblockBody).toMatchObject({
        ok: true,
        task: { id: lowTaskBody.task.id, status: "queued" },
        event: { type: "task.unblocked" },
      });

      const cancel = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${highTaskBody.task.id}/cancel`, {
        reason: "operator requested",
      });
      const cancelBody = await cancel.json();
      expect(cancel.status).toBe(200);
      expect(cancelBody).toMatchObject({
        ok: true,
        command: { type: "cancel", taskId: highTaskBody.task.id },
        pendingCommands: [{ type: "cancel", status: "queued" }],
      });

      database.sqlite
        .query("UPDATE tasks SET status = 'failed' WHERE project_id = ? AND id = ?")
        .run(projectId, lowTaskBody.task.id);
      const retry = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${lowTaskBody.task.id}/retry`, {});
      const retryBody = await retry.json();
      expect(retry.status).toBe(200);
      expect(retryBody).toMatchObject({
        ok: true,
        command: { type: "retry", taskId: lowTaskBody.task.id },
        pendingCommands: [{ type: "retry", status: "queued" }],
      });

      const detail = await fetch(`${baseUrl}/api/public/projects/${projectId}/tasks/${lowTaskBody.task.id}`, {
        headers: publicHeaders(config),
      });
      const detailBody = await detail.json();
      expect(detail.status).toBe(200);
      expect(detailBody).toMatchObject({
        ok: true,
        task: {
          id: lowTaskBody.task.id,
          status: "failed",
          priority: 10,
          pendingCommands: [{ type: "retry", status: "queued" }],
        },
      });
      expect(JSON.stringify(detailBody)).not.toMatch(/bridgeSessionToken|serviceToken|internal-service/i);
    } finally {
      await close();
    }
  });

  test("public session dispatch provider and unsupported command routes stay provider-side-effect free", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_public_sessions", slug: "public-sessions", name: "Public Sessions" });
      const dispatchTask = services.createTask({ id: "task_dispatch", projectId: project.id, title: "Dispatch me", priority: 0 }).task;
      const runningTask = services.createTask({ id: "task_running", projectId: project.id, title: "Running", priority: 10 }).task;
      const cleanupTask = services.createTask({ id: "task_cleanup", projectId: project.id, title: "Cleanup", priority: 5 }).task;

      const runningClaim = services.claimNextTask({
        projectId: project.id,
        sessionId: "session_running",
        bridgeSessionToken: "bridge-token-session",
      });
      expect(runningClaim).toMatchObject({ ok: true, task: { id: runningTask.id } });
      if (!runningClaim.ok) throw new Error("expected running task claim to succeed");
      expect(services.reportStartupSucceeded({ projectId: project.id, sessionId: "session_running", runtimeSessionId: "runtime_running" })).toMatchObject({
        ok: true,
      });
      expect(services.claimNextTask({ projectId: project.id, sessionId: "session_cleanup" })).toMatchObject({ ok: true, task: { id: cleanupTask.id } });
      expect(services.reportStartupSucceeded({ projectId: project.id, sessionId: "session_cleanup" })).toMatchObject({ ok: true });
      expect(
        services.completeSession({
          projectId: project.id,
          taskId: cleanupTask.id,
          sessionId: "session_cleanup",
        }),
      ).toMatchObject({ ok: true });

      const capabilities = await fetch(`${baseUrl}/api/public/providers/capabilities`, {
        headers: publicHeaders(config),
      });
      const capabilitiesBody = await capabilities.json();
      expect(capabilities.status).toBe(200);
      expect(capabilitiesBody).toMatchObject({
        ok: true,
        defaultProvider: "fake",
        providers: [
          { kind: "fake", configured: true, capabilities: { start: true, stop: true, suspend: false, resume: false, fork: false } },
          { kind: "e2b", available: true, capabilities: { start: true, stop: true, suspend: false, resume: false, fork: false } },
          { kind: "docker", available: false, capabilities: { start: false, stop: false } },
        ],
      });

      const sessions = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${runningTask.id}/sessions`, {
        headers: publicHeaders(config),
      });
      const sessionsBody = await sessions.json();
      expect(sessions.status).toBe(200);
      expect(sessionsBody).toMatchObject({
        ok: true,
        sessions: [{ id: "session_running", status: "running", runtimeSessionId: "runtime_running" }],
      });
      expect(JSON.stringify(sessionsBody)).not.toContain("bridge-token-session");

      const dispatch = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${dispatchTask.id}/dispatch`, {
        reason: "operator dispatch",
      });
      const dispatchBody = await dispatch.json();
      expect(dispatch.status).toBe(200);
      expect(dispatchBody).toMatchObject({
        ok: true,
        command: { type: "start", taskId: dispatchTask.id, sessionId: null },
        pendingCommands: [{ type: "start", status: "queued" }],
      });
      expect(
        database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM sessions WHERE task_id = 'task_dispatch'").get()?.count,
      ).toBe(0);

      const interrupt = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${runningTask.id}/sessions/session_running/interrupt`, {
        message: "pause after the current command",
      });
      const interruptBody = await interrupt.json();
      expect(interrupt.status).toBe(200);
      expect(interruptBody).toMatchObject({
        ok: true,
        command: { type: "interrupt", taskId: runningTask.id, sessionId: "session_running" },
        pendingCommands: [{ type: "interrupt", status: "queued" }],
      });

      const steer = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${runningTask.id}/sessions/session_running/steer`, {
        body: "Focus on the failing tests",
        attachments: [{ key: `projects/${project.id}/${runningTask.id}/uploads/context.txt`, fileName: "context.txt" }],
      });
      const steerBody = await steer.json();
      expect(steer.status).toBe(200);
      expect(steerBody).toMatchObject({
        ok: true,
        steering: {
          status: "queued",
          body: "Focus on the failing tests",
          attachments: [{ key: `projects/${project.id}/${runningTask.id}/uploads/context.txt`, fileName: "context.txt" }],
        },
        command: { type: "steer", taskId: runningTask.id, sessionId: "session_running" },
        task: {
          steeringMessages: [
            {
              status: "queued",
              body: "Focus on the failing tests",
              attachments: [{ key: `projects/${project.id}/${runningTask.id}/uploads/context.txt`, fileName: "context.txt" }],
            },
          ],
        },
        pendingCommands: expect.arrayContaining([expect.objectContaining({ type: "steer", status: "queued" })]),
      });

      const steeringPoll = await fetch(`${baseUrl}/steering/poll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [runningClaim.session.bridge.sessionToken.headerName]: runningClaim.session.bridge.sessionToken.token,
        },
        body: JSON.stringify({ projectId: project.id, taskId: runningTask.id, sessionId: "session_running" }),
      });
      const steeringPollBody = await steeringPoll.json();
      expect(steeringPoll.status).toBe(200);
      expect(steeringPollBody).toMatchObject({
        ok: true,
        messages: [
          {
            id: steerBody.steering.id,
            body: "Focus on the failing tests",
            metadata: { attachments: [{ key: `projects/${project.id}/${runningTask.id}/uploads/context.txt` }] },
          },
        ],
      });

      const steeringReport = await fetch(`${baseUrl}/steering/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [runningClaim.session.bridge.sessionToken.headerName]: runningClaim.session.bridge.sessionToken.token,
        },
        body: JSON.stringify({
          projectId: project.id,
          taskId: runningTask.id,
          sessionId: "session_running",
          steeringMessageId: steerBody.steering.id,
          status: "delivered",
        }),
      });
      expect(steeringReport.status).toBe(200);
      expect(await steeringReport.json()).toMatchObject({
        ok: true,
        steering: { id: steerBody.steering.id, status: "delivered" },
        event: { type: "steering.delivered" },
      });
      const detailAfterSteering = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${runningTask.id}`, {
        headers: publicHeaders(config),
      });
      expect(detailAfterSteering.status).toBe(200);
      expect(await detailAfterSteering.json()).toMatchObject({
        ok: true,
        task: { steeringMessages: [{ id: steerBody.steering.id, status: "delivered" }] },
      });

      const invalidSteer = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${runningTask.id}/sessions/session_running/steer`, {
        body: "bad attachment",
        attachments: [{ key: "projects/other/task/uploads/context.txt" }],
      });
      expect(invalidSteer.status).toBe(400);

      const cleanup = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${cleanupTask.id}/sessions/session_cleanup/cleanup`, {
        reason: "demo cleanup",
      });
      const cleanupBody = await cleanup.json();
      expect(cleanup.status).toBe(200);
      expect(cleanupBody).toMatchObject({
        ok: true,
        command: { type: "cleanup", taskId: cleanupTask.id, sessionId: "session_cleanup" },
      });

      const beforeUnsupported = database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM orchestrator_commands").get()?.count;
      const suspend = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${runningTask.id}/sessions/session_running/suspend`, {});
      expect(suspend.status).toBe(501);
      expect(await suspend.json()).toEqual({
        ok: false,
        error: {
          code: "unsupported_provider_command",
          message: "suspend is not supported by the configured runtime providers",
        },
      });
      expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM orchestrator_commands").get()?.count).toBe(
        beforeUnsupported,
      );
    } finally {
      await close();
    }
  });

  test("confirmed public interrupt exposes restart context through bridge steering poll", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_interrupt_restart", slug: "interrupt-restart", name: "Interrupt Restart" });
      const task = services.createTask({ id: "task_interrupt_restart", projectId: project.id, title: "Interrupt restart" }).task;
      const claim = services.claimNextTask({
        projectId: project.id,
        sessionId: "session_interrupt_restart",
        bridgeSessionToken: "interrupt-restart-token",
      });
      expect(claim).toMatchObject({ ok: true });
      if (!claim.ok) throw new Error("expected task claim to succeed");
      expect(services.reportStartupSucceeded({ projectId: project.id, sessionId: "session_interrupt_restart" })).toMatchObject({ ok: true });

      const interrupt = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${task.id}/sessions/session_interrupt_restart/interrupt`, {
        message: "Interrupt requested with 1 queued steering message.",
        steeringContext: { source: "web", messages: [{ id: "steer_previous", body: "try focused tests", status: "queued" }] },
      });
      const interruptBody = await interrupt.json();
      expect(interrupt.status).toBe(200);
      expect(interruptBody).toMatchObject({
        ok: true,
        command: { type: "interrupt" },
        task: {
          steeringMessages: [
            {
              commandId: interruptBody.command.id,
              status: "queued",
              body: "Interrupt requested with 1 queued steering message.",
            },
          ],
        },
      });

      const poll = await fetch(`${baseUrl}/steering/poll`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [claim.session.bridge.sessionToken.headerName]: claim.session.bridge.sessionToken.token,
        },
        body: JSON.stringify({ projectId: project.id, taskId: task.id, sessionId: "session_interrupt_restart" }),
      });
      const pollBody = await poll.json();
      expect(poll.status).toBe(200);
      expect(pollBody).toMatchObject({
        ok: true,
        messages: [
          {
            commandId: interruptBody.command.id,
            confirmedInterrupt: true,
            metadata: {
              restartContext: {
                kind: "confirmed_interrupt_restart",
                steeringContext: { source: "web", messages: [{ id: "steer_previous", body: "try focused tests", status: "queued" }] },
              },
            },
          },
        ],
      });

      const messageId = pollBody.messages[0].id;
      const report = await fetch(`${baseUrl}/steering/report`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [claim.session.bridge.sessionToken.headerName]: claim.session.bridge.sessionToken.token,
        },
        body: JSON.stringify({
          projectId: project.id,
          taskId: task.id,
          sessionId: "session_interrupt_restart",
          steeringMessageId: messageId,
          status: "delivered",
        }),
      });
      expect(report.status).toBe(200);
      expect(await report.json()).toMatchObject({
        ok: true,
        steering: { id: messageId, status: "delivered", commandId: interruptBody.command.id },
      });
      expect(
        database.sqlite
          .query<{ status: string }, [string]>("SELECT status FROM orchestrator_commands WHERE id = ?")
          .get(interruptBody.command.id),
      ).toEqual({ status: "succeeded" });
    } finally {
      await close();
    }
  });

  test("public artifact log and upload planning routes expose scoped metadata without provider writes", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_public_artifacts", slug: "public-artifacts", name: "Public Artifacts" });
      const task = services.createTask({ id: "task_artifacts", projectId: project.id, title: "Artifacts" }).task;
      expect(
        services.claimNextTask({
          projectId: project.id,
          sessionId: "session_artifacts",
          bridgeSessionToken: "artifact-bridge-token",
        }),
      ).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: project.id, sessionId: "session_artifacts" })).toMatchObject({ ok: true });
      expect(
        services.recordDocumentArtifact({
          projectId: project.id,
          taskId: task.id,
          sessionId: "session_artifacts",
          path: "agent-docs/demo-result.md",
          title: "demo-result.md",
          contentType: "text/markdown",
          sizeBytes: 256,
        }),
      ).toMatchObject({ ok: true, artifact: { kind: "document", uri: "agent-docs/demo-result.md" } });
      expect(
        services.recordFinalAssistantResponse({
          projectId: project.id,
          sessionId: "session_artifacts",
          text: "Result: https://example.test/artifact",
        }),
      ).toMatchObject({ ok: true, artifacts: [{ kind: "final_response_url" }] });
      expect(
        services.recordSessionOutput({
          projectId: project.id,
          taskId: task.id,
          sessionId: "session_artifacts",
          stream: "stdout",
          sequence: 1,
          byteOffset: 0,
          text: "artifact log\n",
        }),
      ).toMatchObject({ ok: true, output: { stream: "stdout", lineCount: 1 } });

      const artifacts = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/artifacts`, {
        headers: publicHeaders(config),
      });
      const artifactsBody = await artifacts.json();
      expect(artifacts.status).toBe(200);
      expect(artifactsBody).toMatchObject({
        ok: true,
        artifacts: [
          { kind: "document", uri: "agent-docs/demo-result.md", metadata: { contentType: "text/markdown", sizeBytes: 256 } },
          { kind: "final_response_url", uri: "https://example.test/artifact" },
        ],
      });

      const sessionArtifacts = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/sessions/session_artifacts/artifacts`, {
        headers: publicHeaders(config),
      });
      expect(sessionArtifacts.status).toBe(200);
      expect((await sessionArtifacts.json()).artifacts).toHaveLength(2);

      const logs = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/logs`, {
        headers: publicHeaders(config),
      });
      const logsBody = await logs.json();
      expect(logs.status).toBe(200);
      expect(logsBody).toMatchObject({
        ok: true,
        logStreams: [{ kind: "stdout", byteOffset: 13, lineCount: 1 }],
      });
      expect(JSON.stringify(logsBody)).not.toContain("artifact-bridge-token");

      const upload = await postPublic(baseUrl, config, `/projects/${project.id}/uploads/plan`, {
        taskId: task.id,
        sessionId: "session_artifacts",
        fileName: "../operator note.md",
        contentType: "text/markdown",
      });
      const uploadBody = await upload.json();
      expect(upload.status).toBe(200);
      expect(uploadBody).toMatchObject({
        ok: true,
        upload: {
          adapter: "local",
          bucket: "agent-pool-web-sandbox",
          key: `projects/${project.id}/${task.id}/session_artifacts/_/operator note.md`,
          method: "local_path",
          contentType: "text/markdown",
          headers: {},
          fields: {},
        },
      });
      expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM storage_objects").get()?.count).toBe(0);

      const wrongScope = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/sessions/missing_session/logs`, {
        headers: publicHeaders(config),
      });
      expect(wrongScope.status).toBe(404);
    } finally {
      await close();
    }
  });

  test("public note routes mutate scoped task detail and publish SSE events", async () => {
    const publicSseHub = createPublicSseHub();
    const { baseUrl, config, database, close } = await startTestApi({ publicSseHub });

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_public_notes", slug: "public-notes", name: "Public Notes" });
      const task = services.createTask({ id: "task_notes", projectId: project.id, title: "Notes" }).task;
      expect(services.createSessionAttempt({ id: "session_notes", projectId: project.id, taskId: task.id, status: "running" })).toMatchObject({
        session: { attemptNumber: 1 },
      });
      expect(
        services.recordFinalAssistantResponse({
          projectId: project.id,
          sessionId: "session_notes",
          text: "Final preview: https://example.test/final",
          metadata: { model: "fake" },
        }),
      ).toMatchObject({ ok: true });

      const detail = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}`, {
        headers: publicHeaders(config),
      });
      expect(detail.status).toBe(200);
      expect(await detail.json()).toMatchObject({
        ok: true,
        task: {
          notes: [],
          latestSession: {
            finalResponseText: "Final preview: https://example.test/final",
            finalResponseMetadata: { model: "fake" },
          },
        },
      });

      const streamPromise = readSseUntil(`${baseUrl}/api/public/projects/${project.id}/events`, publicHeaders(config), "note.created");
      await waitForSseClients(publicSseHub, 1);
      const created = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${task.id}/notes`, {
        sessionId: "session_notes",
        body: "Initial operator note",
      });
      const createdBody = await created.json();
      const noteId = createdBody.note.id as string;
      const stream = await streamPromise;
      expect(stream.text).toContain("note.created");
      await stream.close();
      expect(created.status).toBe(201);
      expect(typeof noteId).toBe("string");
      expect(createdBody).toMatchObject({
        ok: true,
        note: {
          id: expect.any(String),
          authorId: config.operator.id,
          body: "Initial operator note",
          sessionId: "session_notes",
        },
        task: { notes: [{ body: "Initial operator note" }] },
        event: { type: "note.created" },
      });

      const notes = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/notes`, {
        headers: publicHeaders(config),
      });
      expect(notes.status).toBe(200);
      expect(await notes.json()).toMatchObject({ ok: true, notes: [{ id: noteId, body: "Initial operator note" }] });

      const updated = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/notes/${noteId}`, {
        method: "PATCH",
        headers: publicHeaders(config),
        body: JSON.stringify({ body: "Updated operator note" }),
      });
      const updatedBody = await updated.json();
      expect(updated.status).toBe(200);
      expect(updatedBody).toMatchObject({
        ok: true,
        note: { id: noteId, body: "Updated operator note" },
        task: { notes: [{ id: noteId, body: "Updated operator note" }] },
        event: { type: "note.updated" },
      });

      const deleted = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}/notes/${noteId}`, {
        method: "DELETE",
        headers: publicHeaders(config),
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({
        ok: true,
        note: { id: noteId, body: "Updated operator note" },
        task: { notes: [] },
        event: { type: "note.deleted" },
      });

      const blank = await postPublic(baseUrl, config, `/projects/${project.id}/tasks/${task.id}/notes`, { body: " " });
      expect(blank.status).toBe(400);
      const wrongScope = await postPublic(baseUrl, config, `/projects/project_missing/tasks/${task.id}/notes`, { body: "bad" });
      expect(wrongScope.status).toBe(404);
    } finally {
      await close();
    }
  });

  test("public SSE streams replay scoped events and clean up clients", async () => {
    const publicSseHub = createPublicSseHub();
    const { baseUrl, config, database, close } = await startTestApi({ publicSseHub });

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_public_sse", slug: "public-sse", name: "Public SSE" });
      const firstTask = services.createTask({ id: "task_sse_first", projectId: project.id, title: "First", priority: 10 }).task;
      const secondTask = services.createTask({ id: "task_sse_second", projectId: project.id, title: "Second" }).task;
      expect(
        services.claimNextTask({
          projectId: project.id,
          sessionId: "session_sse_first",
          bridgeSessionToken: "sse-bridge-token",
        }),
      ).toMatchObject({ ok: true, task: { id: firstTask.id } });
      services.reportStartupSucceeded({ projectId: project.id, sessionId: "session_sse_first", runtimeSessionId: "runtime_sse" });
      services.requestCommand({
        id: "command_sse_dispatch",
        projectId: project.id,
        taskId: secondTask.id,
        type: "start",
        requestedBy: config.operator.id,
      });

      const missingAuth = await fetch(`${baseUrl}/api/public/projects/${project.id}/events`);
      expect(missingAuth.status).toBe(401);

      const allEvents = database.sqlite
        .query<{ id: string; type: string }, []>("SELECT id, type FROM events WHERE project_id = 'project_public_sse' ORDER BY rowid ASC")
        .all();
      const firstEventId = allEvents[0]?.id;
      const secondEventId = allEvents[1]?.id;
      expect(firstEventId).toBeDefined();
      expect(secondEventId).toBeDefined();

      const projectStream = await readSseUntil(`${baseUrl}/api/public/projects/${project.id}/events`, publicHeaders(config), "task.created");
      expect(projectStream.response.status).toBe(200);
      expect(projectStream.response.headers.get("content-type")).toContain("text/event-stream");
      expect(projectStream.text).toContain("event: task.created");
      expect(projectStream.text).toContain(firstTask.id);
      expect(projectStream.text).not.toContain("sse-bridge-token");
      expect(projectStream.text).not.toContain("web-sandbox.db");
      expect(publicSseHub.clientCount).toBe(1);
      await projectStream.close();
      await waitForSseClients(publicSseHub, 0);

      const replay = await readSseUntil(
        `${baseUrl}/api/public/projects/${project.id}/events`,
        { ...publicHeaders(config), "last-event-id": firstEventId ?? "" },
        secondEventId ?? "task_sse_second",
      );
      expect(replay.text).not.toContain(`id: ${firstEventId}`);
      expect(replay.text).toContain(`id: ${secondEventId}`);
      await replay.close();
      await waitForSseClients(publicSseHub, 0);

      const sessionStream = await readSseUntil(
        `${baseUrl}/api/public/projects/${project.id}/tasks/${firstTask.id}/sessions/session_sse_first/events`,
        publicHeaders(config),
        "session_sse_first",
      );
      expect(sessionStream.text).toContain("session_sse_first");
      expect(sessionStream.text).not.toContain(secondTask.id);
      await sessionStream.close();
      await waitForSseClients(publicSseHub, 0);

      const dispatchStream = await readSseUntil(`${baseUrl}/api/public/projects/${project.id}/dispatch/events`, publicHeaders(config), "command.queued");
      expect(dispatchStream.text).toContain("command.queued");
      expect(dispatchStream.text).not.toContain("event: task.created");
      await dispatchStream.close();
      await waitForSseClients(publicSseHub, 0);
    } finally {
      await close();
    }
  });

  test("public API errors and mutation responses use safe deterministic shapes", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const firstProject = await postPublic(baseUrl, config, "/projects", {
        slug: "error-shapes",
        name: "Error Shapes",
      });
      const firstProjectBody = await firstProject.json();
      const projectId = firstProjectBody.project.id;
      expect(firstProject.status).toBe(201);

      const duplicateProject = await postPublic(baseUrl, config, "/projects", {
        slug: "error-shapes",
        name: "Duplicate",
      });
      expect(duplicateProject.status).toBe(409);
      expect(await duplicateProject.json()).toEqual({
        ok: false,
        error: { code: "conflict", message: "resource already exists" },
      });

      const missingTitle = await postPublic(baseUrl, config, `/projects/${projectId}/tasks`, {});
      expect(missingTitle.status).toBe(400);
      expect(await missingTitle.json()).toEqual({
        ok: false,
        error: { code: "validation_error", message: "title is required" },
      });

      const missingProject = await postPublic(baseUrl, config, "/projects/missing_project/tasks", {
        title: "No project",
      });
      expect(missingProject.status).toBe(404);
      expect(await missingProject.json()).toEqual({
        ok: false,
        error: { code: "not_found", message: "project not found: missing_project" },
      });

      const services = createCanonicalStateServices(database.sqlite);
      const task = services.createTask({ id: "task_error_running", projectId, title: "Running task" }).task;
      expect(services.claimNextTask({ projectId, sessionId: "session_error_running" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId, sessionId: "session_error_running" })).toMatchObject({ ok: true });

      const invalidDispatch = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${task.id}/dispatch`, {});
      expect(invalidDispatch.status).toBe(409);
      expect(await invalidDispatch.json()).toEqual({
        ok: false,
        error: { code: "invalid_state", message: "start requires queued task; got running" },
      });
      expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM orchestrator_commands").get()?.count).toBe(0);

      const otherProject = services.createProject({ id: "project_other_scope", slug: "other-scope", name: "Other Scope" });
      const otherTask = services.createTask({ id: "task_other_scope", projectId: otherProject.id, title: "Other" }).task;
      expect(services.claimNextTask({ projectId: otherProject.id, sessionId: "session_other_scope" })).toMatchObject({ ok: true });
      const crossScope = await fetch(`${baseUrl}/api/public/projects/${projectId}/tasks/${task.id}/sessions/session_other_scope`, {
        headers: publicHeaders(config),
      });
      expect(crossScope.status).toBe(404);
      expect(await crossScope.json()).toEqual({
        ok: false,
        error: { code: "not_found", message: "session not found: session_other_scope" },
      });
      expect(otherTask.projectId).toBe(otherProject.id);

      const unsupported = await postPublic(baseUrl, config, `/projects/${projectId}/tasks/${task.id}/sessions/session_error_running/resume`, {});
      expect(unsupported.status).toBe(501);
      expect(await unsupported.json()).toEqual({
        ok: false,
        error: {
          code: "unsupported_provider_command",
          message: "resume is not supported by the configured runtime providers",
        },
      });
    } finally {
      await close();
    }
  });

  test("public responses SSE and auth boundaries redact backend secrets and DB paths", async () => {
    const publicSseHub = createPublicSseHub();
    const { baseUrl, config, database, close } = await startTestApi({ publicSseHub });

    try {
      const services = createCanonicalStateServices(database.sqlite);
      const project = services.createProject({ id: "project_public_security", slug: "public-security", name: "Public Security" });
      const task = services.createTask({ id: "task_public_security", projectId: project.id, title: "Security" }).task;
      services.requestCommand({
        id: "command_public_security",
        projectId: project.id,
        taskId: task.id,
        type: "start",
        payload: {
          serviceToken: config.serviceToken.token,
          note: "safe note",
        },
      });
      services.appendEvent({
        id: "event_public_sensitive",
        projectId: project.id,
        taskId: task.id,
        type: "task.sensitive",
        payload: {
          serviceToken: config.serviceToken.token,
          bridgeSessionToken: "bridge-token-sensitive",
          apiDatabasePath: database.path,
          legacyDatabasePath: "/Users/cam/.agent-pool/data/agent-pool.db",
          nested: { githubToken: "ghp_sensitive" },
        },
      });

      const detail = await fetch(`${baseUrl}/api/public/projects/${project.id}/tasks/${task.id}`, {
        headers: publicHeaders(config),
      });
      const detailText = await detail.text();
      expect(detail.status).toBe(200);
      expect(detailText).toContain("safe note");
      expect(detailText).toContain("[REDACTED]");
      expect(detailText).not.toContain(config.serviceToken.token);
      expect(detailText).not.toContain("bridge-token-sensitive");
      expect(detailText).not.toContain(database.path);
      expect(detailText).not.toContain(".agent-pool/data/agent-pool.db");
      expect(detailText).not.toContain("ghp_sensitive");

      const stream = await readSseUntil(`${baseUrl}/api/public/projects/${project.id}/events`, publicHeaders(config), "task.sensitive");
      expect(stream.text).toContain("task.sensitive");
      expect(stream.text).toContain("[REDACTED]");
      expect(stream.text).not.toContain(config.serviceToken.token);
      expect(stream.text).not.toContain("bridge-token-sensitive");
      expect(stream.text).not.toContain(database.path);
      expect(stream.text).not.toContain(".agent-pool/data/agent-pool.db");
      await stream.close();
      await waitForSseClients(publicSseHub, 0);

      expect(
        services.claimNextTask({
          projectId: project.id,
          sessionId: "session_public_security",
          bridgeSessionToken: "real-bridge-session-token",
        }),
      ).toMatchObject({ ok: true });
      const bridgeWithPublicAuth = await postBridgeCallback(
        baseUrl,
        "output",
        {
          "content-type": "application/json",
          "x-agent-pool-operator-id": config.operator.id,
        },
        {
          kind: "output",
          projectId: project.id,
          taskId: task.id,
          sessionId: "session_public_security",
          stream: "stdout",
          sequence: 1,
          byteOffset: 0,
          text: "should not write\n",
        },
      );
      expect(bridgeWithPublicAuth.status).toBe(401);
      expect(await bridgeWithPublicAuth.json()).toEqual({ ok: false, error: "invalid_session_token", reason: "missing" });
    } finally {
      await close();
    }
  });

  test("internal orchestrator namespace requires service-token auth", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, { method: "POST" });
      const invalid = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: "wrong",
        },
      });
      const ok = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(ok.status).toBe(400);
      expect(await ok.json()).toMatchObject({
        ok: false,
        error: "missing_project_id",
      });

      const publicAuth = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/startup-succeeded`, {
        method: "POST",
        headers: {
          "x-agent-pool-operator-id": config.operator.id,
        },
      });
      expect(publicAuth.status).toBe(401);
    } finally {
      await close();
    }
  });

  test("internal smoke fixture rejects missing or invalid service-token requests without mutation", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/smoke/seed`, { method: "POST" });
      const invalid = await fetch(`${baseUrl}/internal/smoke/seed`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: "wrong",
        },
      });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM projects").get()?.count).toBe(0);
    } finally {
      await close();
    }
  });

  test("internal smoke fixture is disabled outside test auth unless smoke mode is explicit", async () => {
    const disabled = await startTestApi({
      env: {
        AUTH_MODE: "local",
        INTERNAL_SERVICE_TOKEN: "local-service-token",
        OPERATOR_ID: "operator-local",
        OPERATOR_EMAIL: "operator@example.test",
        COMPOSE_SMOKE_ENABLED: "false",
      },
    });

    try {
      const response = await fetch(`${disabled.baseUrl}/internal/smoke/seed`, {
        method: "POST",
        headers: {
          [disabled.config.serviceToken.headerName]: disabled.config.serviceToken.token,
        },
      });

      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ ok: false, error: "smoke_disabled" });
      expect(disabled.database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM projects").get()?.count).toBe(0);
    } finally {
      await disabled.close();
    }

    const enabled = await startTestApi({
      env: {
        AUTH_MODE: "local",
        INTERNAL_SERVICE_TOKEN: "local-service-token",
        OPERATOR_ID: "operator-local",
        OPERATOR_EMAIL: "operator@example.test",
        COMPOSE_SMOKE_ENABLED: "true",
      },
    });

    try {
      const response = await fetch(`${enabled.baseUrl}/internal/smoke/seed`, {
        method: "POST",
        headers: {
          [enabled.config.serviceToken.headerName]: enabled.config.serviceToken.token,
        },
      });

      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, projectId: "compose-smoke" });
    } finally {
      await enabled.close();
    }
  });

  test("internal smoke fixture seed is idempotent and status reports control-plane progress", async () => {
    const { baseUrl, config, database, queue, close } = await startTestApi();

    try {
      const headers = {
        "content-type": "application/json",
        [config.serviceToken.headerName]: config.serviceToken.token,
      };
      const runtimeSource = {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/e2b-smoke",
      };
      const firstSeed = await fetch(`${baseUrl}/internal/smoke/seed`, {
        method: "POST",
        headers,
        body: JSON.stringify({ runtimeSource }),
      });
      const firstSeedBody = await firstSeed.json();
      const secondSeed = await fetch(`${baseUrl}/internal/smoke/seed`, { method: "POST", headers });
      const secondSeedBody = await secondSeed.json();

      expect(firstSeed.status).toBe(200);
      expect(firstSeedBody).toMatchObject({
        ok: true,
        projectId: "compose-smoke",
        taskId: "compose-smoke-task-1",
        created: { project: true, task: true },
        project: { id: "compose-smoke", slug: "compose-smoke", status: "active" },
        task: { id: "compose-smoke-task-1", status: "queued" },
        outbox: { queued: 1, published: 0, failed: 0, total: 1 },
      });
      expect(firstSeedBody.queues).toEqual([
        {
          projectId: "compose-smoke",
          kind: "task",
          queue: "project-tasks.compose-smoke",
          durable: true,
        },
        {
          projectId: "compose-smoke",
          kind: "control",
          queue: "project-control.compose-smoke",
          durable: true,
        },
      ]);
      expect(secondSeed.status).toBe(200);
      expect(secondSeedBody).toMatchObject({
        ok: true,
        created: { project: false, task: false },
        outbox: { queued: 1, published: 0, failed: 0, total: 1 },
      });
      expect(queue.declaredQueues).toEqual(firstSeedBody.queues);

      const claim = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers,
        body: JSON.stringify({ projectId: "compose-smoke", sessionId: "session_smoke", runtimeProvider: "fake" }),
      });
      const claimBody = await claim.json();
      expect(claimBody).toMatchObject({ ok: true, claimed: true, task: { id: "compose-smoke-task-1", runtimeSource } });
      expect(JSON.stringify(claimBody.task)).not.toMatch(/token|secret|github_pat_|ghp_/i);

      const bridge = claimBody.session.bridge;
      const callbackHeaders = {
        "content-type": "application/json",
        [bridge.sessionToken.headerName]: bridge.sessionToken.token,
      };
      const startupSucceeded = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_smoke/startup-succeeded`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          projectId: "compose-smoke",
          runtimeSessionId: "runtime_smoke",
        }),
      });
      expect(startupSucceeded.status).toBe(200);

      await expect(
        postBridgeCallback(baseUrl, "heartbeat", callbackHeaders, {
          kind: "heartbeat",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postBridgeCallback(baseUrl, "output", callbackHeaders, {
          kind: "output",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
          stream: "stdout",
          sequence: 1,
          byteOffset: 0,
          text: "smoke ok\n",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postBridgeCallback(baseUrl, "document", callbackHeaders, {
          kind: "document",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
          path: "agent-docs/smoke-result.md",
          title: "smoke-result.md",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postBridgeCallback(baseUrl, "final_response", callbackHeaders, {
          kind: "final_response",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
          text: "Smoke result https://example.test/smoke",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postBridgeCallback(baseUrl, "completion", callbackHeaders, {
          kind: "completion",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
        }),
      ).resolves.toMatchObject({ status: 200 });
      await expect(
        postBridgeCallback(baseUrl, "cleanup", callbackHeaders, {
          kind: "cleanup",
          projectId: "compose-smoke",
          taskId: "compose-smoke-task-1",
          sessionId: "session_smoke",
          reason: "smoke completed",
        }),
      ).resolves.toMatchObject({ status: 200 });

      const status = await fetch(`${baseUrl}/internal/smoke/status`, { headers });
      const statusBody = await status.json();

      expect(status.status).toBe(200);
      expect(statusBody).toMatchObject({
        ok: true,
        projectId: "compose-smoke",
        taskId: "compose-smoke-task-1",
        task: { id: "compose-smoke-task-1", status: "completed" },
        sessions: {
          total: 1,
          succeeded: 1,
          latest: {
            id: "session_smoke",
            status: "succeeded",
            runtimeProvider: "fake",
            runtimeSessionId: "runtime_smoke",
          },
        },
        heartbeat: { fresh: 1, latestAt: "2026-05-12T12:00:00.000Z" },
        output: { events: 1, totalLineCount: 1 },
        artifacts: { documents: 1, finalResponseUrls: 1 },
        finalResponse: { recorded: true, sessions: 1, artifacts: 1 },
        completion: { completed: true, events: 1 },
        failure: { failed: false, events: 0 },
        cleanup: { completed: true, events: 1 },
      });
      expect(statusBody.outbox.total).toBeGreaterThan(1);
      expect(database.sqlite.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM tasks WHERE project_id = 'compose-smoke'").get()?.count).toBe(1);
    } finally {
      await close();
    }
  });

  test("claimNextTask internal endpoint claims work and returns structured no-work response", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({
        id: "task_1",
        projectId: "project_a",
        title: "First task",
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "main",
          taskBranchPrefix: "agent-pool/task",
        },
      });

      const claimed = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a", sessionId: "session_1", runtimeProvider: "test-provider" }),
      });
      const noWork = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a", sessionId: "session_2" }),
      });

      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({
        ok: true,
        claimed: true,
        task: {
          id: "task_1",
          projectId: "project_a",
          status: "running",
          runtimeSource: {
            repositoryUrl: "https://github.com/example/tiny-fixture.git",
            baseRef: "main",
            taskBranchPrefix: "agent-pool/task",
          },
        },
        session: {
          id: "session_1",
          taskId: "task_1",
          status: "starting",
          runtimeProvider: "test-provider",
          bridge: {
            projectId: "project_a",
            taskId: "task_1",
            sessionId: "session_1",
            callbackBaseUrl: config.bridge.callbackBaseUrl,
            sessionToken: {
              headerName: config.bridge.sessionTokenHeaderName,
            },
          },
        },
      });
      expect(noWork.status).toBe(200);
      expect(await noWork.json()).toEqual({ ok: true, claimed: false, reason: "no_eligible_task" });
      const stored = database.sqlite
        .query<
          { bridge_session_token: string | null; bridge_session_token_header: string | null },
          []
        >("SELECT bridge_session_token, bridge_session_token_header FROM sessions WHERE id = 'session_1'")
        .get();
      expect(stored?.bridge_session_token).toStartWith("bridge_token_");
      expect(stored?.bridge_session_token).not.toBe(config.serviceToken.token);
      expect(stored?.bridge_session_token_header).toBe(config.bridge.sessionTokenHeaderName);
    } finally {
      await close();
    }
  });

  test("claimNextCommand internal endpoint claims queued commands and returns structured no-work response", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });
      const command = services.requestCommand({
        id: "command_cancel",
        projectId: "project_a",
        taskId: "task_1",
        type: "cancel",
        payload: { reason: "operator" },
      });
      expect(command.ok).toBe(true);

      const claimed = await fetch(`${baseUrl}/internal/orchestrator/commands/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a" }),
      });
      const noWork = await fetch(`${baseUrl}/internal/orchestrator/commands/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_a" }),
      });

      expect(claimed.status).toBe(200);
      expect(await claimed.json()).toMatchObject({
        ok: true,
        claimed: true,
        command: {
          id: "command_cancel",
          projectId: "project_a",
          taskId: "task_1",
          sessionId: null,
          type: "cancel",
          status: "running",
          payload: { reason: "operator" },
        },
      });
      expect(noWork.status).toBe(200);
      expect(await noWork.json()).toEqual({ ok: true, claimed: false, reason: "no_queued_command" });
    } finally {
      await close();
    }
  });

  test("command report endpoints transition running commands and handle duplicates idempotently", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });
      const requested = services.requestCommand({ id: "command_cancel", projectId: "project_a", taskId: "task_1", type: "cancel" });
      expect(requested.ok).toBe(true);
      const claimed = services.claimNextCommand({ projectId: "project_a" });
      expect(claimed.ok).toBe(true);

      const started = await postCommandReport(baseUrl, config, "command_cancel", "started", { projectId: "project_a" });
      const succeeded = await postCommandReport(baseUrl, config, "command_cancel", "succeeded", { projectId: "project_a" });
      const duplicate = await postCommandReport(baseUrl, config, "command_cancel", "succeeded", { projectId: "project_a" });
      const failedConflict = await postCommandReport(baseUrl, config, "command_cancel", "failed", {
        projectId: "project_a",
        errorMessage: "too late",
      });

      expect(started.status).toBe(200);
      expect(await started.json()).toMatchObject({
        ok: true,
        idempotent: false,
        command: { id: "command_cancel", status: "running" },
        event: { type: "command.started" },
      });
      expect(succeeded.status).toBe(200);
      expect(await succeeded.json()).toMatchObject({ ok: true, idempotent: false, command: { id: "command_cancel", status: "succeeded" } });
      expect(duplicate.status).toBe(200);
      expect(await duplicate.json()).toMatchObject({ ok: true, idempotent: true, command: { id: "command_cancel", status: "succeeded" } });
      expect(failedConflict.status).toBe(409);
      expect(await failedConflict.json()).toMatchObject({ ok: false, error: { code: "conflict" } });
    } finally {
      await close();
    }
  });

  test("startup report endpoints transition claimed sessions and handle safe duplicates idempotently", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_success", projectId: "project_a", title: "Success task" });
      services.createTask({ id: "task_failure", projectId: "project_a", title: "Failure task" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_success" })).toMatchObject({ ok: true });
      services.createSessionAttempt({ id: "session_failure", projectId: "project_a", taskId: "task_failure", status: "starting" });
      database.sqlite.query("UPDATE tasks SET status = 'running' WHERE id = 'task_failure'").run();

      const succeeded = await postStartupReport(baseUrl, config, "session_success", "succeeded", {
        projectId: "project_a",
        runtimeSessionId: "runtime_success",
      });
      const duplicateSucceeded = await postStartupReport(baseUrl, config, "session_success", "succeeded", {
        projectId: "project_a",
        runtimeSessionId: "runtime_success",
      });
      const failed = await postStartupReport(baseUrl, config, "session_failure", "failed", {
        projectId: "project_a",
        errorMessage: "provider image failed",
      });
      const duplicateFailed = await postStartupReport(baseUrl, config, "session_failure", "failed", {
        projectId: "project_a",
        errorMessage: "provider image failed",
      });

      expect(succeeded.status).toBe(200);
      expect(await succeeded.json()).toMatchObject({
        ok: true,
        idempotent: false,
        session: { id: "session_success", status: "running", runtimeSessionId: "runtime_success" },
        task: { id: "task_success", status: "running" },
        event: { type: "session.startup_succeeded" },
      });
      expect(duplicateSucceeded.status).toBe(200);
      expect(await duplicateSucceeded.json()).toMatchObject({ ok: true, idempotent: true, session: { id: "session_success", status: "running" } });
      expect(failed.status).toBe(200);
      expect(await failed.json()).toMatchObject({
        ok: true,
        idempotent: false,
        session: { id: "session_failure", status: "failed" },
        task: { id: "task_failure", status: "blocked" },
        event: { type: "session.startup_failed" },
      });
      expect(duplicateFailed.status).toBe(200);
      expect(await duplicateFailed.json()).toMatchObject({ ok: true, idempotent: true, session: { id: "session_failure", status: "failed" } });
    } finally {
      await close();
    }
  });

  test("heartbeat and reconcile endpoints update session heartbeat state", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_stale", projectId: "project_a", title: "Stale task" });
      services.createTask({ id: "task_lost", projectId: "project_a", title: "Lost task" });
      services.createTask({ id: "task_fresh", projectId: "project_a", title: "Fresh task" });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_stale" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_stale" })).toMatchObject({ ok: true });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_lost" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_lost" })).toMatchObject({ ok: true });
      expect(services.claimNextTask({ projectId: "project_a", sessionId: "session_fresh" })).toMatchObject({ ok: true });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_fresh" })).toMatchObject({ ok: true });

      const heartbeat = await postSessionHeartbeat(baseUrl, config, "session_fresh", {
        projectId: "project_a",
        observedAt: "2026-01-01T00:01:30.000Z",
      });
      database.sqlite
        .query(
          `
            UPDATE sessions
            SET last_heartbeat_at = CASE id
              WHEN 'session_lost' THEN '2026-01-01T00:00:00.000Z'
              WHEN 'session_stale' THEN '2026-01-01T00:00:30.000Z'
              ELSE last_heartbeat_at
            END
          `,
        )
        .run();
      const reconcile = await postReconcile(baseUrl, config, {
        projectId: "project_a",
        lostBefore: "2026-01-01T00:00:00.000Z",
        staleBefore: "2026-01-01T00:01:00.000Z",
        now: "2026-01-01T00:02:00.000Z",
      });

      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toMatchObject({
        ok: true,
        session: { id: "session_fresh", heartbeatStatus: "fresh", lastHeartbeatAt: "2026-01-01T00:01:30.000Z" },
        event: { type: "session.heartbeat" },
      });
      expect(reconcile.status).toBe(200);
      expect(await reconcile.json()).toMatchObject({
        ok: true,
        stale: [{ id: "session_stale", heartbeatStatus: "stale" }],
        lost: [{ id: "session_lost", status: "failed", heartbeatStatus: "lost" }],
      });
      expect(
        database.sqlite
          .query<{ session_status: string; heartbeat_status: string; task_status: string }, []>(
            `
              SELECT s.status AS session_status, s.heartbeat_status, t.status AS task_status
              FROM sessions s
              JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
              WHERE s.id = 'session_lost'
            `,
          )
          .get(),
      ).toEqual({ session_status: "failed", heartbeat_status: "lost", task_status: "blocked" });
    } finally {
      await close();
    }
  });

  test("bridge callbacks validate session token and persist heartbeat and output", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_bridge", slug: "project-bridge", name: "Bridge" });
      services.createTask({ id: "task_bridge", projectId: "project_bridge", title: "Bridge task" });

      const claim = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_bridge", sessionId: "session_bridge", runtimeProvider: "fake" }),
      });
      const claimBody = await claim.json();
      const bridge = claimBody.session.bridge;

      const heartbeat = await fetch(`${baseUrl}/callbacks/heartbeat`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "heartbeat",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      });
      const output = await fetch(`${baseUrl}/callbacks/output`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "output",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          stream: "stdout",
          sequence: 1,
          byteOffset: 0,
          text: "hello\n",
          observedAt: "2026-05-12T12:00:01.000Z",
        }),
      });
      const document = await fetch(`${baseUrl}/callbacks/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "document",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          path: "agent-docs/result.md",
          title: "result.md",
          contentType: "text/markdown",
          sizeBytes: 42,
        }),
      });
      const finalResponse = await fetch(`${baseUrl}/callbacks/final_response`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "final_response",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          text: "Preview https://example.test/result",
          metadata: { model: "fake" },
          urlCandidates: ["https://example.test/result"],
        }),
      });
      const invalidToken = await fetch(`${baseUrl}/callbacks/output`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: "wrong-token",
        },
        body: JSON.stringify({
          kind: "output",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          stream: "stdout",
          sequence: 2,
          byteOffset: 6,
          text: "bad\n",
        }),
      });
      const wrongKind = await fetch(`${baseUrl}/callbacks/output`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "heartbeat",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          observedAt: "2026-05-12T12:00:02.000Z",
        }),
      });
      const invalidDocumentPath = await fetch(`${baseUrl}/callbacks/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "document",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          path: "docs/result.md",
        }),
      });
      const crossSession = await fetch(`${baseUrl}/callbacks/document`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify({
          kind: "document",
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "missing_session",
          path: "agent-docs/result.md",
        }),
      });

      expect(heartbeat.status).toBe(200);
      expect(await heartbeat.json()).toMatchObject({
        ok: true,
        session: { id: "session_bridge", heartbeatStatus: "fresh", lastHeartbeatAt: "2026-05-12T12:00:00.000Z" },
        event: { type: "session.heartbeat" },
      });
      expect(output.status).toBe(200);
      expect(await output.json()).toMatchObject({
        ok: true,
        output: {
          projectId: "project_bridge",
          taskId: "task_bridge",
          sessionId: "session_bridge",
          stream: "stdout",
          byteOffset: 6,
          lineCount: 1,
        },
        event: { type: "session.output" },
      });
      expect(document.status).toBe(200);
      expect(await document.json()).toMatchObject({
        ok: true,
        artifact: { kind: "document", uri: "agent-docs/result.md", title: "result.md" },
        event: { type: "artifact.document.registered" },
      });
      expect(finalResponse.status).toBe(200);
      expect(await finalResponse.json()).toMatchObject({
        ok: true,
        artifacts: [{ kind: "final_response_url", uri: "https://example.test/result" }],
        event: { type: "session.final_response.recorded" },
      });
      expect(invalidToken.status).toBe(403);
      expect(await invalidToken.json()).toEqual({ ok: false, error: "invalid_session_token", reason: "invalid" });
      expect(wrongKind.status).toBe(400);
      expect(await wrongKind.json()).toEqual({ ok: false, error: "invalid_callback_kind" });
      expect(invalidDocumentPath.status).toBe(409);
      expect(await invalidDocumentPath.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_state", message: "document path is outside allowed bridge roots: docs/result.md" },
      });
      expect(crossSession.status).toBe(404);
      expect(
        database.sqlite
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM events WHERE project_id = 'project_bridge' AND type = 'session.output'",
          )
          .get()?.count,
      ).toBe(1);
      expect(
        database.sqlite
          .query<{ byte_offset: number; line_count: number }, []>(
            "SELECT byte_offset, line_count FROM log_streams WHERE project_id = 'project_bridge' AND session_id = 'session_bridge'",
          )
          .get(),
      ).toEqual({ byte_offset: 6, line_count: 1 });
      expect(
        database.sqlite
          .query<{ kind: string; uri: string }, []>(
            "SELECT kind, uri FROM artifacts WHERE project_id = 'project_bridge' ORDER BY kind, uri",
          )
          .all(),
      ).toEqual([
        { kind: "document", uri: "agent-docs/result.md" },
        { kind: "final_response_url", uri: "https://example.test/result" },
      ]);
    } finally {
      await close();
    }
  });

  test("bridge terminal callbacks complete fail and cleanup sessions idempotently", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    async function claimTask(taskId: string, sessionId: string) {
      const response = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_terminal", sessionId, runtimeProvider: "fake" }),
      });
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, claimed: true, task: { id: taskId }, session: { id: sessionId } });
      return body.session.bridge;
    }

    async function postCallback(kind: string, bridge: { readonly sessionToken: { readonly headerName: string; readonly token: string } }, body: Readonly<Record<string, unknown>>) {
      return fetch(`${baseUrl}/callbacks/${kind}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: bridge.sessionToken.token,
        },
        body: JSON.stringify(body),
      });
    }

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_terminal", slug: "project-terminal", name: "Terminal" });
      services.createTask({ id: "task_complete", projectId: "project_terminal", title: "Complete" });
      services.createTask({ id: "task_fail", projectId: "project_terminal", title: "Fail" });
      services.createTask({ id: "task_unsafe", projectId: "project_terminal", title: "Unsafe" });

      const completeBridge = await claimTask("task_complete", "session_complete");
      expect(
        services.reportStartupSucceeded({
          projectId: "project_terminal",
          sessionId: "session_complete",
          runtimeSessionId: "runtime_complete",
        }),
      ).toMatchObject({ ok: true });
      const completion = await postCallback("completion", completeBridge, {
        kind: "completion",
        projectId: "project_terminal",
        taskId: "task_complete",
        sessionId: "session_complete",
        observedAt: "2026-05-12T12:00:00.000Z",
        metadata: { exitCode: 0 },
      });
      const cleanup = await postCallback("cleanup", completeBridge, {
        kind: "cleanup",
        projectId: "project_terminal",
        taskId: "task_complete",
        sessionId: "session_complete",
        reason: "completed",
      });
      const duplicateCleanup = await postCallback("cleanup", completeBridge, {
        kind: "cleanup",
        projectId: "project_terminal",
        taskId: "task_complete",
        sessionId: "session_complete",
        reason: "completed",
      });

      const failBridge = await claimTask("task_fail", "session_fail");
      expect(
        services.reportStartupSucceeded({
          projectId: "project_terminal",
          sessionId: "session_fail",
          runtimeSessionId: "runtime_fail",
        }),
      ).toMatchObject({ ok: true });
      const failure = await postCallback("failure", failBridge, {
        kind: "failure",
        projectId: "project_terminal",
        taskId: "task_fail",
        sessionId: "session_fail",
        errorMessage: "runtime exited 1",
        observedAt: "2026-05-12T12:00:01.000Z",
      });

      const unsafeBridge = await claimTask("task_unsafe", "session_unsafe");
      const unsafeCompletion = await postCallback("completion", unsafeBridge, {
        kind: "completion",
        projectId: "project_terminal",
        taskId: "task_unsafe",
        sessionId: "session_unsafe",
      });

      expect(completion.status).toBe(200);
      expect(await completion.json()).toMatchObject({
        ok: true,
        idempotent: false,
        session: { id: "session_complete", status: "succeeded" },
        task: { id: "task_complete", status: "completed" },
        event: { type: "session.completed" },
      });
      expect(cleanup.status).toBe(200);
      expect(await cleanup.json()).toMatchObject({ ok: true, idempotent: false, event: { type: "session.cleanup" } });
      expect(duplicateCleanup.status).toBe(200);
      expect(await duplicateCleanup.json()).toMatchObject({
        ok: true,
        idempotent: true,
        event: { type: "session.cleanup.idempotent" },
      });
      expect(failure.status).toBe(200);
      expect(await failure.json()).toMatchObject({
        ok: true,
        session: { id: "session_fail", status: "failed" },
        task: { id: "task_fail", status: "failed" },
        event: { type: "session.failed" },
      });
      expect(unsafeCompletion.status).toBe(409);
      expect(await unsafeCompletion.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_state", message: "completion requires running session; got starting" },
      });
      expect(
        database.sqlite
          .query<{ id: string; status: string }, []>(
            "SELECT id, status FROM tasks WHERE project_id = 'project_terminal' ORDER BY id",
          )
          .all(),
      ).toEqual([
        { id: "task_complete", status: "completed" },
        { id: "task_fail", status: "failed" },
        { id: "task_unsafe", status: "running" },
      ]);
    } finally {
      await close();
    }
  });

  test("bridge duplicate callbacks are idempotent or safely rejected without duplicate state mutation", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    async function claimTask(taskId: string, sessionId: string) {
      const response = await fetch(`${baseUrl}/internal/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
        body: JSON.stringify({ projectId: "project_duplicates", sessionId, runtimeProvider: "fake" }),
      });
      const body = await response.json();
      expect(body).toMatchObject({ ok: true, claimed: true, task: { id: taskId }, session: { id: sessionId } });
      return body.session.bridge;
    }

    async function postCallback(
      kind: string,
      bridge: { readonly sessionToken: { readonly headerName: string; readonly token: string } },
      body: Readonly<Record<string, unknown>>,
      token = bridge.sessionToken.token,
    ) {
      return fetch(`${baseUrl}/callbacks/${kind}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [bridge.sessionToken.headerName]: token,
        },
        body: JSON.stringify(body),
      });
    }

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_duplicates", slug: "project-duplicates", name: "Duplicates" });
      services.createTask({ id: "task_complete", projectId: "project_duplicates", title: "Complete" });
      services.createTask({ id: "task_fail", projectId: "project_duplicates", title: "Fail" });

      const completeBridge = await claimTask("task_complete", "session_complete");
      expect(
        services.reportStartupSucceeded({
          projectId: "project_duplicates",
          sessionId: "session_complete",
          runtimeSessionId: "runtime_complete",
        }),
      ).toMatchObject({ ok: true });

      const heartbeatBody = {
        kind: "heartbeat",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        observedAt: "2026-05-12T12:00:00.000Z",
      };
      const outputBody = {
        kind: "output",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        stream: "stdout",
        sequence: 1,
        byteOffset: 0,
        text: "hello\n",
        observedAt: "2026-05-12T12:00:01.000Z",
      };
      const documentBody = {
        kind: "document",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        path: "agent-docs/result.md",
        title: "result.md",
        contentType: "text/markdown",
        sizeBytes: 6,
      };
      const finalResponseBody = {
        kind: "final_response",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        text: "Done https://example.test/duplicate",
        metadata: { model: "fake" },
        urlCandidates: ["https://example.test/duplicate"],
      };
      const completionBody = {
        kind: "completion",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        observedAt: "2026-05-12T12:00:02.000Z",
      };
      const cleanupBody = {
        kind: "cleanup",
        projectId: "project_duplicates",
        taskId: "task_complete",
        sessionId: "session_complete",
        reason: "completed",
      };

      const heartbeat = await postCallback("heartbeat", completeBridge, heartbeatBody);
      const duplicateHeartbeat = await postCallback("heartbeat", completeBridge, heartbeatBody);
      const output = await postCallback("output", completeBridge, outputBody);
      const duplicateOutput = await postCallback("output", completeBridge, outputBody);
      const invalidOutput = await postCallback(
        "output",
        completeBridge,
        { ...outputBody, sequence: 2, byteOffset: 6, text: "bad\n" },
        "wrong-token",
      );
      const document = await postCallback("document", completeBridge, documentBody);
      const duplicateDocument = await postCallback("document", completeBridge, documentBody);
      const finalResponse = await postCallback("final_response", completeBridge, finalResponseBody);
      const duplicateFinalResponse = await postCallback("final_response", completeBridge, finalResponseBody);
      const completion = await postCallback("completion", completeBridge, completionBody);
      const duplicateCompletion = await postCallback("completion", completeBridge, completionBody);
      const cleanup = await postCallback("cleanup", completeBridge, cleanupBody);
      const duplicateCleanup = await postCallback("cleanup", completeBridge, cleanupBody);

      expect(heartbeat.status).toBe(200);
      expect(duplicateHeartbeat.status).toBe(409);
      expect(await duplicateHeartbeat.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_state", message: "duplicate heartbeat callback for session_complete" },
      });
      expect(output.status).toBe(200);
      expect(duplicateOutput.status).toBe(409);
      expect(await duplicateOutput.json()).toMatchObject({
        ok: false,
        error: { code: "invalid_state", message: "duplicate output callback for stdout sequence 1" },
      });
      expect(invalidOutput.status).toBe(403);
      expect(document.status).toBe(200);
      expect(duplicateDocument.status).toBe(200);
      expect(await duplicateDocument.json()).toMatchObject({ ok: true, idempotent: true });
      expect(finalResponse.status).toBe(200);
      expect(duplicateFinalResponse.status).toBe(200);
      expect(await duplicateFinalResponse.json()).toMatchObject({
        ok: true,
        artifacts: [],
        event: { type: "session.final_response.idempotent" },
      });
      expect(completion.status).toBe(200);
      expect(duplicateCompletion.status).toBe(200);
      expect(await duplicateCompletion.json()).toMatchObject({
        ok: true,
        idempotent: true,
        event: { type: "session.completed.idempotent" },
      });
      expect(cleanup.status).toBe(200);
      expect(duplicateCleanup.status).toBe(200);
      expect(await duplicateCleanup.json()).toMatchObject({
        ok: true,
        idempotent: true,
        event: { type: "session.cleanup.idempotent" },
      });
      expect(
        database.sqlite
          .query<{ type: string; count: number }, []>(
            `
              SELECT type, COUNT(*) AS count
              FROM events
              WHERE project_id = 'project_duplicates' AND session_id = 'session_complete'
                AND type IN ('session.heartbeat', 'session.output', 'session.completed', 'session.completed.idempotent', 'session.cleanup', 'session.cleanup.idempotent')
              GROUP BY type
              ORDER BY type
            `,
          )
          .all(),
      ).toEqual([
        { type: "session.cleanup", count: 1 },
        { type: "session.cleanup.idempotent", count: 1 },
        { type: "session.completed", count: 1 },
        { type: "session.completed.idempotent", count: 1 },
        { type: "session.heartbeat", count: 1 },
        { type: "session.output", count: 1 },
      ]);
      expect(
        database.sqlite
          .query<{ kind: string; count: number }, []>(
            "SELECT kind, COUNT(*) AS count FROM artifacts WHERE project_id = 'project_duplicates' GROUP BY kind ORDER BY kind",
          )
          .all(),
      ).toEqual([
        { kind: "document", count: 1 },
        { kind: "final_response_url", count: 1 },
      ]);
      expect(
        database.sqlite
          .query<{ byte_offset: number; line_count: number }, []>(
            "SELECT byte_offset, line_count FROM log_streams WHERE project_id = 'project_duplicates' AND session_id = 'session_complete'",
          )
          .get(),
      ).toEqual({ byte_offset: 6, line_count: 1 });

      const failBridge = await claimTask("task_fail", "session_fail");
      expect(
        services.reportStartupSucceeded({
          projectId: "project_duplicates",
          sessionId: "session_fail",
          runtimeSessionId: "runtime_fail",
        }),
      ).toMatchObject({ ok: true });
      const failureBody = {
        kind: "failure",
        projectId: "project_duplicates",
        taskId: "task_fail",
        sessionId: "session_fail",
        errorMessage: "runtime failed",
      };
      const failure = await postCallback("failure", failBridge, failureBody);
      const duplicateFailure = await postCallback("failure", failBridge, failureBody);

      expect(failure.status).toBe(200);
      expect(duplicateFailure.status).toBe(200);
      expect(await duplicateFailure.json()).toMatchObject({
        ok: true,
        idempotent: true,
        event: { type: "session.failed.idempotent" },
      });
      expect(
        database.sqlite
          .query<{ session_status: string; task_status: string }, []>(
            `
              SELECT s.status AS session_status, t.status AS task_status
              FROM sessions s
              JOIN tasks t ON t.project_id = s.project_id AND t.id = s.task_id
              WHERE s.project_id = 'project_duplicates' AND s.id = 'session_fail'
            `,
          )
          .get(),
      ).toEqual({ session_status: "failed", task_status: "failed" });
    } finally {
      await close();
    }
  });

  test("internal orchestrator endpoints are not exposed as public routes and validate bodies", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const publicRoute = await fetch(`${baseUrl}/orchestrator/tasks/claim-next`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const missingCommandProject = await fetch(`${baseUrl}/internal/orchestrator/commands/cmd_1/started`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const missingHeartbeatProject = await fetch(`${baseUrl}/internal/orchestrator/sessions/session_1/heartbeat`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });
      const missingReconcileThresholds = await fetch(`${baseUrl}/internal/orchestrator/reconcile`, {
        method: "POST",
        headers: {
          [config.serviceToken.headerName]: config.serviceToken.token,
        },
      });

      expect(publicRoute.status).toBe(404);
      expect(missingCommandProject.status).toBe(400);
      expect(await missingCommandProject.json()).toMatchObject({ error: "missing_project_id" });
      expect(missingHeartbeatProject.status).toBe(400);
      expect(await missingHeartbeatProject.json()).toMatchObject({ error: "missing_project_id" });
      expect(missingReconcileThresholds.status).toBe(400);
      expect(await missingReconcileThresholds.json()).toMatchObject({ error: "missing_reconcile_thresholds" });
    } finally {
      await close();
    }
  });

  test("metrics exposes service and database migration gauges", async () => {
    const { baseUrl, close } = await startTestApi();

    try {
      const response = await fetch(`${baseUrl}/metrics`);
      const text = await response.text();

      expect(response.status).toBe(200);
      expect(text).toContain("agent_pool_api_info");
      expect(text).toContain("agent_pool_api_database_connected 1");
      expect(text).toContain("agent_pool_api_database_applied_migrations");
      expect(text).toContain("agent_pool_api_queue_adapter_initialized 1");
      expect(text).toContain("agent_pool_api_outbox_publisher_initialized 1");
      expect(text).toContain("agent_pool_api_outbox_queued 0");
      expect(text).toContain("agent_pool_api_outbox_published 0");
      expect(text).toContain("agent_pool_api_outbox_failed 0");
      expect(text).toContain("agent_pool_api_outbox_loop_running 0");
      expect(text).toContain("agent_pool_api_outbox_loop_in_flight 0");
      expect(text).toContain("agent_pool_api_outbox_loop_ticks_total 0");
      expect(text).toContain("agent_pool_api_outbox_loop_failures_total 0");
      expect(text).toContain("agent_pool_api_storage_adapter_initialized 1");
    } finally {
      await close();
    }
  });

  test("health and metrics expose explicitly started outbox publisher loop state", async () => {
    const loop = createOutboxPublisherLoop({
      publisher: {
        async publishQueuedAsync() {
          return {
            scanned: 2,
            published: [
              {
                outboxId: "outbox_1",
                projectId: "project_a",
                queue: "project-tasks.project_a",
                queueKind: "task",
              },
            ],
            failed: [],
          };
        },
      },
      intervalMs: 1000,
      scheduler: {
        setInterval() {
          return "outbox-loop";
        },
        clearInterval() {},
      },
    });
    loop.start();
    await loop.tick();
    const { baseUrl, close } = await startTestApi({ outboxPublisherLoop: loop });

    try {
      const health = await fetch(`${baseUrl}/health`);
      const healthBody = await health.json();
      const metrics = await fetch(`${baseUrl}/metrics`);
      const metricsText = await metrics.text();

      expect(health.status).toBe(200);
      expect(healthBody.adapters.outboxPublisher.loop).toMatchObject({
        initialized: true,
        running: true,
        inFlight: false,
        ticks: 1,
        failures: 0,
        lastScanned: 2,
        lastPublished: 1,
        lastFailed: 0,
        lastError: null,
      });
      expect(metricsText).toContain("agent_pool_api_outbox_loop_running 1");
      expect(metricsText).toContain("agent_pool_api_outbox_loop_in_flight 0");
      expect(metricsText).toContain("agent_pool_api_outbox_loop_ticks_total 1");
      expect(metricsText).toContain("agent_pool_api_outbox_loop_failures_total 0");
    } finally {
      loop.stop();
      await close();
    }
  });
});

async function postCommandReport(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  commandId: string,
  report: "started" | "succeeded" | "failed",
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator/commands/${commandId}/${report}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}

async function postStartupReport(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  sessionId: string,
  report: "succeeded" | "failed",
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator/sessions/${sessionId}/startup-${report}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}

async function postSessionHeartbeat(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  sessionId: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator/sessions/${sessionId}/heartbeat`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}

async function postReconcile(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator/reconcile`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}

async function postBridgeCallback(
  baseUrl: string,
  kind: string,
  headers: HeadersInit,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/callbacks/${kind}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function publicHeaders(config: ReturnType<typeof loadConfig>): HeadersInit {
  return {
    "content-type": "application/json",
    "x-agent-pool-operator-id": config.operator.id,
  };
}

async function postPublic(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/api/public${path}`, {
    method: "POST",
    headers: publicHeaders(config),
    body: JSON.stringify(body),
  });
}

async function readSseUntil(
  url: string,
  headers: HeadersInit,
  expectedText: string,
): Promise<{ readonly response: Response; readonly text: string; readonly close: () => Promise<void> }> {
  const controller = new AbortController();
  const response = await fetch(url, { headers, signal: controller.signal });
  const reader = response.body?.getReader();
  let text = "";

  if (!reader) {
    throw new Error("SSE response did not expose a reader");
  }

  for (let index = 0; index < 5 && !text.includes(expectedText); index += 1) {
    const chunk = await Promise.race([
      reader.read(),
      new Promise<ReadableStreamReadResult<Uint8Array>>((resolve) =>
        setTimeout(() => resolve({ done: true, value: undefined }), 250),
      ),
    ]);
    if (chunk.done) break;
    text += new TextDecoder().decode(chunk.value);
  }

  return {
    response,
    text,
    async close() {
      controller.abort();
      await reader.cancel().catch(() => {});
    },
  };
}

async function waitForSseClients(hub: PublicSseHub, expected: number): Promise<void> {
  for (let index = 0; index < 20; index += 1) {
    if (hub.clientCount === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  expect(hub.clientCount).toBe(expected);
}

async function startTestApi(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly outboxPublisherLoop?: OutboxPublisherLoop;
  readonly queue?: RabbitMqAdapter;
  readonly publicSseHub?: PublicSseHub;
} = {}): Promise<{
  readonly baseUrl: string;
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: ReturnType<typeof openApiDatabase>;
  readonly queue: RabbitMqAdapter;
  readonly close: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-app-"));
  cleanupPaths.push(tempDir);
  const dbPath = join(tempDir, "db", "web-sandbox.db");
  const env = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: dbPath,
    ...options.env,
  };
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const queue = options.queue ?? createRabbitMqAdapter(config.rabbitmq);
  const app = createApiApp({ config, database, queue, outboxPublisherLoop: options.outboxPublisherLoop, publicSseHub: options.publicSseHub });
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("test API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    database,
    queue,
    async close() {
      await new Promise<void>((resolve, reject) => {
        server.close((error?: Error) => {
          if (error) reject(error);
          else resolve();
        });
      });
      database.close();
    },
  };
}
