import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadConfig } from "@agent-pool/config";
import { createCanonicalStateServices } from "@agent-pool/db";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import { createApiApp } from "../src/app";
import { API_DATABASE_PATH_ENV, openApiDatabase } from "../src/database";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("API runtime sandbox lifecycle endpoints", () => {
  test("internal lifecycle endpoints require service token auth", async () => {
    const { baseUrl, config, close } = await startTestApi();

    try {
      const missing = await fetch(`${baseUrl}/internal/orchestrator/runtime-sandboxes/claim-finalization`, { method: "POST" });
      const invalid = await fetch(`${baseUrl}/internal/orchestrator/runtime-sandboxes/claim-finalization`, {
        method: "POST",
        headers: { [config.serviceToken.headerName]: "wrong" },
      });
      const valid = await postInternal(baseUrl, config, "/runtime-sandboxes/claim-finalization", { projectId: "missing" });

      expect(missing.status).toBe(401);
      expect(await missing.json()).toMatchObject({ ok: false, reason: "missing" });
      expect(invalid.status).toBe(403);
      expect(await invalid.json()).toMatchObject({ ok: false, reason: "invalid" });
      expect(valid.status).toBe(200);
      expect(await valid.json()).toEqual({ ok: true, claimed: false, reason: "no_runtime_sandbox_finalization" });
    } finally {
      await close();
    }
  });

  test("claims finalization, records snapshots, cleans up sandboxes, and launches from ready source snapshots", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_source", projectId: "project_a", title: "Source task" });
      services.createTask({ id: "task_reuse", projectId: "project_a", title: "Reuse task" });
      services.createTask({ id: "task_wrong_provider", projectId: "project_a", title: "Wrong provider" });

      const sourceClaim = await postInternal(baseUrl, config, "/tasks/claim-next", {
        projectId: "project_a",
        sessionId: "session_source",
        runtimeProvider: "e2b",
      });
      expect(sourceClaim.status).toBe(200);
      expect(await sourceClaim.json()).toMatchObject({ ok: true, claimed: true, session: { id: "session_source" } });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_source", runtimeSessionId: "sandbox_source" })).toMatchObject({
        ok: true,
      });
      expect(
        services.completeSession({
          projectId: "project_a",
          taskId: "task_source",
          sessionId: "session_source",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        services.cleanupSession({
          projectId: "project_a",
          taskId: "task_source",
          sessionId: "session_source",
          reason: "bridge cleanup completed",
        }),
      ).toMatchObject({ ok: true });

      const finalization = await postInternal(baseUrl, config, "/runtime-sandboxes/claim-finalization", {
        projectId: "project_a",
        cleanupGraceBefore: "2026-05-12T12:00:31.000Z",
      });
      const finalizationBody = await finalization.json();
      expect(finalization.status).toBe(200);
      expect(finalizationBody).toMatchObject({
        ok: true,
        claimed: true,
        finalization: {
          sessionId: "session_source",
          provider: "e2b",
          providerSandboxId: "sandbox_source",
          snapshotRequired: true,
        },
      });

      const snapshotCreated = await postInternal(baseUrl, config, `/runtime-sandboxes/${finalizationBody.finalization.id}/snapshot-created`, {
        projectId: "project_a",
        providerSnapshotId: "snapshot_provider_source",
        expiresAt: "2030-05-12T12:00:31.000Z",
        metadata: { mode: "api-test" },
      });
      const snapshotCreatedBody = await snapshotCreated.json();
      expect(snapshotCreated.status).toBe(200);
      expect(snapshotCreatedBody).toMatchObject({
        ok: true,
        snapshot: {
          provider: "e2b",
          providerSnapshotId: "snapshot_provider_source",
          status: "ready",
        },
      });
      const cleanup = await postInternal(baseUrl, config, `/runtime-sandboxes/${finalizationBody.finalization.id}/cleanup-succeeded`, {
        projectId: "project_a",
      });
      expect(cleanup.status).toBe(200);
      expect(await cleanup.json()).toMatchObject({ ok: true, runtimeSandbox: { status: "cleanup_succeeded" } });

      const reuseClaim = await postInternal(baseUrl, config, "/tasks/claim-next", {
        projectId: "project_a",
        sessionId: "session_reuse",
        runtimeProvider: "e2b",
        sourceSnapshotId: snapshotCreatedBody.snapshot.id,
      });
      expect(reuseClaim.status).toBe(200);
      expect(await reuseClaim.json()).toMatchObject({
        ok: true,
        claimed: true,
        task: { id: "task_reuse" },
        session: {
          id: "session_reuse",
          sourceSnapshot: {
            id: snapshotCreatedBody.snapshot.id,
            provider: "e2b",
            providerSnapshotId: "snapshot_provider_source",
          },
        },
      });

      const invalidReuse = await postInternal(baseUrl, config, "/tasks/claim-next", {
        projectId: "project_a",
        sessionId: "session_wrong_provider",
        runtimeProvider: "fake",
        sourceSnapshotId: snapshotCreatedBody.snapshot.id,
      });
      expect(invalidReuse.status).toBe(409);
      expect(await invalidReuse.json()).toMatchObject({
        ok: false,
        error: {
          code: "invalid_source_snapshot",
          message: expect.stringContaining("source snapshot provider mismatch"),
        },
      });

      database.sqlite
        .query(
          `
            INSERT INTO session_snapshots (id, project_id, session_id, provider, status, provider_snapshot_id, expires_at)
            VALUES ('snapshot_expired', 'project_a', 'session_source', 'e2b', 'ready', 'snapshot_provider_expired', '2026-05-12T12:00:31.000Z')
          `,
        )
        .run();
      const expiredClaim = await postInternal(baseUrl, config, "/snapshots/claim-expired", {
        projectId: "project_a",
        now: "2026-05-12T12:00:32.000Z",
      });
      expect(expiredClaim.status).toBe(200);
      expect(await expiredClaim.json()).toMatchObject({
        ok: true,
        claimed: true,
        snapshot: { id: "snapshot_expired", providerSnapshotId: "snapshot_provider_expired" },
      });

      const deleted = await postInternal(baseUrl, config, "/snapshots/snapshot_expired/deleted", {
        projectId: "project_a",
      });
      expect(deleted.status).toBe(200);
      expect(await deleted.json()).toMatchObject({ ok: true, snapshot: { id: "snapshot_expired", status: "deleted" } });
    } finally {
      await close();
    }
  });

  test("malicious fixture security events make successful sessions snapshot-risky", async () => {
    const { baseUrl, config, database, close } = await startTestApi();

    try {
      const services = createCanonicalStateServices(database.sqlite);
      services.createProject({ id: "project_a", slug: "project-a", name: "Project A" });
      services.createTask({ id: "task_malicious", projectId: "project_a", title: "Malicious fixture" });
      const claim = await postInternal(baseUrl, config, "/tasks/claim-next", {
        projectId: "project_a",
        sessionId: "session_malicious",
        runtimeProvider: "e2b",
      });
      expect(claim.status).toBe(200);
      expect(await claim.json()).toMatchObject({ ok: true, claimed: true, session: { id: "session_malicious" } });
      expect(services.reportStartupSucceeded({ projectId: "project_a", sessionId: "session_malicious", runtimeSessionId: "sandbox_malicious" })).toMatchObject({
        ok: true,
      });

      const outputs = [
        { securityKind: "command-policy", allowed: false, reason: "gh_auth_token_forbidden" },
        { securityKind: "dependency-install-failed", allowed: false, lockfileChanged: true },
        { securityKind: "egress-denied", allowed: false, host: "undeclared.example" },
        { securityKind: "credentials-scrub-failed", allowed: false, reason: "scrub-incomplete" },
      ];
      for (const [index, output] of outputs.entries()) {
        services.recordSessionOutput({
          projectId: "project_a",
          taskId: "task_malicious",
          sessionId: "session_malicious",
          stream: "system",
          sequence: index + 1,
          byteOffset: index,
          text: `${JSON.stringify({ type: "security", ...output })}\n`,
          observedAt: "2026-05-12T12:00:00.000Z",
        });
      }

      expect(
        services.completeSession({
          projectId: "project_a",
          taskId: "task_malicious",
          sessionId: "session_malicious",
          observedAt: "2026-05-12T12:00:00.000Z",
        }),
      ).toMatchObject({ ok: true });
      expect(
        services.cleanupSession({
          projectId: "project_a",
          taskId: "task_malicious",
          sessionId: "session_malicious",
          reason: "bridge cleanup completed",
        }),
      ).toMatchObject({ ok: true });

      const finalization = await postInternal(baseUrl, config, "/runtime-sandboxes/claim-finalization", {
        projectId: "project_a",
        cleanupGraceBefore: "2026-05-12T12:00:31.000Z",
      });
      expect(finalization.status).toBe(200);
      expect(await finalization.json()).toMatchObject({
        ok: true,
        claimed: true,
        finalization: {
          sessionId: "session_malicious",
          snapshotRequired: false,
          snapshotEligibilityStatus: "risk",
          snapshotRiskReasons: expect.arrayContaining([
            "command-denied",
            "egress-denied",
            "install-failed",
            "lockfile-mutated",
            "scrub-incomplete",
          ]),
        },
      });
    } finally {
      await close();
    }
  });
});

async function startTestApi(): Promise<{
  readonly baseUrl: string;
  readonly config: ReturnType<typeof loadConfig>;
  readonly database: ReturnType<typeof openApiDatabase>;
  readonly close: () => Promise<void>;
}> {
  const tempDir = await mkdtemp(join(tmpdir(), "agent-pool-api-lifecycle-"));
  cleanupPaths.push(tempDir);
  const env = {
    AUTH_MODE: "test",
    HOME: join(tempDir, "home"),
    [API_DATABASE_PATH_ENV]: join(tempDir, "db", "web-sandbox.db"),
  };
  const config = loadConfig(env);
  const database = openApiDatabase(env);
  const app = createApiApp({ config, database, queue: createRabbitMqAdapter(config.rabbitmq) });
  const server = app.listen(0);
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("test API server did not bind to a TCP port");
  }

  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    config,
    database,
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

async function postInternal(
  baseUrl: string,
  config: ReturnType<typeof loadConfig>,
  path: string,
  body: Readonly<Record<string, unknown>>,
): Promise<Response> {
  return fetch(`${baseUrl}/internal/orchestrator${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [config.serviceToken.headerName]: config.serviceToken.token,
    },
    body: JSON.stringify(body),
  });
}
