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
      const firstSeed = await fetch(`${baseUrl}/internal/smoke/seed`, { method: "POST", headers });
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
      expect(claimBody).toMatchObject({ ok: true, claimed: true, task: { id: "compose-smoke-task-1" } });

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
      services.createTask({ id: "task_1", projectId: "project_a", title: "First task" });

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
        task: { id: "task_1", projectId: "project_a", status: "running" },
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

async function startTestApi(options: {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly outboxPublisherLoop?: OutboxPublisherLoop;
  readonly queue?: RabbitMqAdapter;
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
  const app = createApiApp({ config, database, queue, outboxPublisherLoop: options.outboxPublisherLoop });
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
