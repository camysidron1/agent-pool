import { describe, expect, test } from "bun:test";

import type { PublicTaskDetail } from "../src/api";
import {
  canPreviewArtifact,
  formatRawLogEntries,
  formatSafeJsonValue,
  formatSafeText,
  getArtifactHref,
  getArtifactPreviewJson,
  getArtifactStatus,
  getArtifactTitle,
  getAttemptTimeline,
  getEvidenceReviewMarkerClass,
  getFinalResultDetail,
  getLiveEvidenceReview,
  getSessionInitializationMilestones,
  getRawLogEntries,
  getSecurityLifecycleBadges,
  getSecurityTimeline,
  groupArtifacts,
  shouldFollowRawLogScroll,
  summarizeLogFallback,
} from "../src/task-detail";

describe("web task detail helpers", () => {
  test("extracts raw output events in sequence order", () => {
    const entries = getRawLogEntries({
      ...detailTask(),
      events: [
        outputEvent("event-2", 2, "world\n"),
        { ...outputEvent("event-1", 1, "hello "), createdAt: "2026-05-13T00:00:00.000Z" },
        {
          id: "event-ignore",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          commandId: null,
          type: "session.output",
          payload: { stream: "stdout" },
          createdAt: "2026-05-13T00:02:00.000Z",
        },
      ],
    });

    expect(entries.map((entry) => entry.id)).toEqual(["event-1", "event-2"]);
    expect(entries[0]).toMatchObject({ stream: "stdout", sequence: 1, text: "hello " });
    expect(formatRawLogEntries(entries)).toBe("hello world\n");
  });

  test("summarizes log metadata when raw event text is unavailable", () => {
    expect(
      summarizeLogFallback([
        {
          id: "log-a",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          kind: "stderr",
          byteOffset: 42,
          lineCount: 1,
          createdAt: "2026-05-13T00:00:00.000Z",
          updatedAt: "2026-05-13T00:01:00.000Z",
        },
      ]),
    ).toEqual(["stderr · 1 line · offset 42"]);
  });

  test("pauses raw log following when the user scrolls away from the bottom", () => {
    expect(shouldFollowRawLogScroll({ scrollHeight: 1000, scrollTop: 776, clientHeight: 200 })).toBe(true);
    expect(shouldFollowRawLogScroll({ scrollHeight: 1000, scrollTop: 500, clientHeight: 200 })).toBe(false);
  });

  test("groups artifacts by detail-view order and extracts safe preview metadata", () => {
    const document = artifact("artifact-doc", "document", "agent-docs/result.md", {
      title: "result.md",
      metadata: { status: "ready", contentType: "text/markdown" },
    });
    const url = artifact("artifact-url", "final_response_url", "https://example.test/result");
    const file = artifact("artifact-file", "file", "blob://artifact", { metadata: { externalStatus: "syncing", url: "javascript:bad" } });

    const groups = groupArtifacts([url, file, document]);

    expect(groups.map((group) => group.kind)).toEqual(["document", "file", "final_response_url"]);
    expect(getArtifactTitle(document)).toBe("result.md");
    expect(getArtifactStatus(document)).toBe("ready");
    expect(getArtifactStatus(file)).toBe("syncing");
    expect(canPreviewArtifact(document)).toBe(true);
    expect(canPreviewArtifact(url)).toBe(false);
    expect(getArtifactHref(url)).toBe("https://example.test/result");
    expect(getArtifactHref(file)).toBeNull();
  });

  test("builds attempt timeline and final result details from public task detail", () => {
    const detail = {
      ...detailTask(),
      latestSession: session("session-2", 2, "succeeded", {
        finalResponseText: "Done: https://example.test/result",
        finalResponseMetadata: { model: "fake" },
        finalResponseRecordedAt: "2026-05-13T00:04:00.000Z",
      }),
      sessions: [
        session("session-2", 2, "succeeded", {
          finalResponseText: "Done: https://example.test/result",
          finalResponseMetadata: { model: "fake" },
          finalResponseRecordedAt: "2026-05-13T00:04:00.000Z",
        }),
        session("session-1", 1, "failed", { staleAt: "2026-05-13T00:02:00.000Z" }),
      ],
      artifacts: [artifact("artifact-url", "final_response_url", "https://example.test/result")],
    };

    const timeline = getAttemptTimeline(detail);
    const result = getFinalResultDetail(detail);

    expect(timeline.map((item) => item.session.id)).toEqual(["session-1", "session-2"]);
    expect(timeline.map((item) => item.title)).toEqual(["Attempt 1", "Attempt 2"]);
    expect(timeline[1]?.isLatest).toBe(true);
    expect(timeline[0]?.heartbeat).toContain("stale");
    expect(result).toMatchObject({
      recorded: true,
      sessionId: "session-2",
      text: "Done: https://example.test/result",
      metadata: { model: "fake" },
      urls: ["https://example.test/result"],
    });
  });

  test("summarizes sandbox initialization milestones for task investigation", () => {
    const detail = {
      ...detailTask(),
      runtimeSource: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/task",
        allowedEgressDomains: ["github.com"],
        commandProfile: "agent-pool-bun-pr",
      },
      latestSession: session("session-1", 1, "running", {
        finalResponseMetadata: { runner: "codex" },
        runtimeSessionId: "sandbox_1",
      }),
      sessions: [
        session("session-1", 1, "running", {
          finalResponseMetadata: { runner: "codex" },
          runtimeSessionId: "sandbox_1",
        }),
      ],
      events: [
        outputEvent("event-codex", 1, "codex runner starting\n"),
      ],
    };

    expect(getSessionInitializationMilestones(detail, detail.latestSession)).toEqual([
      { id: "sandbox", label: "Set up cloud container", status: "done", detail: "Sandbox sandbox_1" },
      {
        id: "repository",
        label: "Cloned repository",
        status: "done",
        detail: "https://github.com/example/tiny-fixture.git @ main",
      },
      { id: "setup", label: "Run setup script", status: "skipped", detail: "No setup script configured." },
      { id: "agent", label: "Started Codex", status: "done", detail: "codex" },
    ]);
  });

  test("builds a redacted security timeline from sandbox lifecycle events", () => {
    const completedSession = {
      ...session("session-a", 1, "succeeded", { runtimeSessionId: "sandbox_1" }),
      startedAt: "2026-05-13T00:00:00.000Z",
    };
    const detail = {
      ...detailTask(),
      runtimeSource: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/task",
        allowedEgressDomains: ["github.com"],
        commandProfile: "agent-pool-bun-pr",
      },
      latestSession: completedSession,
      sessions: [completedSession],
      events: [
        outputEvent(
          "event-install-started",
          1,
          `${JSON.stringify({
            type: "security",
            securityKind: "dependency-install-started",
            allowed: true,
            policy: "agent-pool-bun-pr",
            proxyToken: "short-lived-github-token",
          })}\n`,
        ),
        outputEvent(
          "event-package",
          2,
          `${JSON.stringify({
            type: "security.package",
            securityKind: "package-registry",
            ecosystem: "npm",
            registryHost: "registry.npmjs.org",
            packageName: "left-pad",
            requestedVersion: "1.3.0",
            resolvedVersion: "1.3.0",
            decision: "allowed",
            allowed: true,
            reason: "session_allowed",
          })}\n`,
        ),
        outputEvent(
          "event-command",
          3,
          `${JSON.stringify({
            type: "security",
            securityKind: "command-policy",
            allowed: false,
            command: "cat short-lived-github-token",
            reason: "credential_access_forbidden",
          })}\n`,
        ),
        outputEvent(
          "event-egress",
          4,
          `${JSON.stringify({
            type: "security.egress",
            securityKind: "egress",
            allowed: false,
            host: "undeclared.example",
            reason: "not_declared",
          })}\n`,
        ),
        outputEvent(
          "event-scrub",
          5,
          `${JSON.stringify({
            type: "security",
            securityKind: "credentials-scrub-failed",
            allowed: false,
            reason: "scrub-incomplete",
            remainingCount: 1,
            token: "short-lived-github-token",
          })}\n`,
        ),
        outputEvent(
          "event-snapshot",
          6,
          `${JSON.stringify({
            type: "security",
            securityKind: "snapshot-decision",
            allowed: false,
            snapshotEligibilityStatus: "risk",
            snapshotRiskReasons: ["egress-denied", "scrub-incomplete"],
          })}\n`,
        ),
        {
          id: "event-provider-cleanup",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          commandId: null,
          type: "runtime_sandbox.cleanup_succeeded",
          payload: {},
          createdAt: "2026-05-13T00:00:07.000Z",
        },
      ],
    };

    const timeline = getSecurityTimeline(detail);

    expect(timeline.map((item) => item.label)).toEqual([
      "Sandbox created",
      "Repository cloned",
      "Command policy loaded",
      "Install started",
      "Package allowed",
      "Command denied",
      "Egress denied",
      "Credential scrub failed",
      "Snapshot decision",
      "Sandbox destroyed",
    ]);
    expect(timeline.map((item) => item.tone)).toEqual([
      "allowed",
      "allowed",
      "allowed",
      "allowed",
      "allowed",
      "denied",
      "denied",
      "blocked",
      "warning",
      "allowed",
    ]);
    expect(timeline.find((item) => item.label === "Command denied")?.detail).toContain("[redacted]");
    expect(JSON.stringify(timeline)).not.toContain("short-lived-github-token");
    expect(getSecurityLifecycleBadges(detail).map((badge) => [badge.id, badge.tone])).toEqual([
      ["egress", "danger"],
      ["policy", "danger"],
      ["scrub", "danger"],
      ["snapshot", "warning"],
    ]);
  });

  test("handles missing security events without synthetic noise", () => {
    expect(getSecurityTimeline(detailTask())).toEqual([]);
  });

  test("builds live evidence review from artifact and PR diagnostics", () => {
    const completedSession = session("session-a", 1, "succeeded", {
      runtimeSessionId: "sandbox-a",
      finalResponseMetadata: {
        runner: "codex",
        pr: {
          url: "https://github.com/example/tiny-fixture/pull/123",
          branch: "agent-pool/e2b-smoke/run-1/task-a",
          finalCommitSha: "abc123",
          diffStat: "1 file changed",
          checks: { status: "passed", total: 1, passed: 1, failed: 0 },
        },
        transcriptSummary: {
          cleanupObserved: true,
          snapshotStatus: "ready",
          credentialScrubStatus: "succeeded",
          egress: { denied: 0 },
          policy: { denied: 0 },
        },
      },
      finalResponseRecordedAt: "2026-05-13T00:04:00.000Z",
    });
    const detail = {
      ...detailTask(),
      latestSession: completedSession,
      sessions: [completedSession],
      artifacts: [
        artifact("artifact-evidence", "file", "storage://agent-pool-web-sandbox/evidence/pass.json", {
          title: "E2B smoke evidence pass",
          metadata: evidenceMetadata({
            status: "pass",
            stageDiagnostics: {
              stages: [
                { id: "cleanup", status: "passed", detail: "Provider destroyed." },
                { id: "snapshot", status: "passed", detail: "Snapshot ready." },
              ],
            },
          }),
        }),
      ],
      events: [
        {
          id: "event-provider-cleanup",
          projectId: "project-a",
          taskId: "task-a",
          sessionId: "session-a",
          commandId: null,
          type: "runtime_sandbox.cleanup_succeeded",
          payload: {},
          createdAt: "2026-05-13T00:00:07.000Z",
        },
      ],
    };

    const review = getLiveEvidenceReview(detail);

    expect(review.status).toBe("passed");
    expect(review.markerClassName).toBe("evidence-review-marker evidence-review-marker-passed");
    expect(review.prUrl).toBe("https://github.com/example/tiny-fixture/pull/123");
    expect(review.branch).toBe("agent-pool/e2b-smoke/run-1/task-a");
    expect(review.commit).toBe("abc123");
    expect(review.diffStat).toBe("1 file changed");
    expect(review.checkStatusSummary).toBe("passed (1/1 passed)");
    expect(review.securityVerdict).toBe("proxy-only ready");
    expect(review.cleanupStatus).toBe("provider destroyed");
    expect(review.snapshotStatus).toBe("Ready");
    expect(review.diagnosticsLinks.map((link) => link.label)).toEqual(["Task JSON", "Task artifacts", "Session artifacts"]);
    expect(canPreviewArtifact(review.artifact!)).toBe(true);
  });

  test("maps live evidence review statuses and responsive marker classes", () => {
    expect(getLiveEvidenceReview(detailTask()).status).toBe("unknown");
    expect(getLiveEvidenceReview({ ...detailTask(), artifacts: [evidenceArtifact("blocked", { blockers: [{ field: "callback", reason: "tunnel missing" }] })] }).status).toBe("blocked");
    expect(getLiveEvidenceReview({ ...detailTask(), artifacts: [evidenceArtifact("failed")] }).status).toBe("failed");
    expect(
      getLiveEvidenceReview({
        ...detailTask(),
        artifacts: [
          evidenceArtifact("pass", {
            snapshotDecision: { status: "risk", reasons: ["scrub incomplete"] },
            stageDiagnostics: { stages: [{ id: "snapshot", status: "risk", detail: "scrub incomplete" }] },
          }),
        ],
      }).status,
    ).toBe("cleanup-risk");
    expect([
      getEvidenceReviewMarkerClass("passed"),
      getEvidenceReviewMarkerClass("blocked"),
      getEvidenceReviewMarkerClass("failed"),
      getEvidenceReviewMarkerClass("cleanup-risk"),
      getEvidenceReviewMarkerClass("unknown"),
    ]).toEqual([
      "evidence-review-marker evidence-review-marker-passed",
      "evidence-review-marker evidence-review-marker-blocked",
      "evidence-review-marker evidence-review-marker-failed",
      "evidence-review-marker evidence-review-marker-cleanup-risk",
      "evidence-review-marker evidence-review-marker-unknown",
    ]);
  });

  test("redacts evidence previews, final metadata helpers, and raw log text", () => {
    const unsafe = "github_pat_secret_token ~/.agent-pool/data/agent-pool.db https://proxy-user:proxy-pass@gateway.local";
    const evidence = evidenceArtifact("pass", {
      redactedLaunchSpec: {
        environment: {
          secrets: {
            GITHUB_TOKEN: unsafe,
          },
        },
      },
      stageDiagnostics: {
        transcript: unsafe,
      },
    });

    const preview = getArtifactPreviewJson(evidence);
    const safeJson = formatSafeJsonValue({ token: unsafe, nested: { path: unsafe } });
    const safeText = formatSafeText(unsafe);
    const rawLogs = formatRawLogEntries([readRawLogEntryForTest("event-unsafe", unsafe)]);

    for (const rendered of [preview, safeJson, safeText, rawLogs]) {
      expect(rendered).not.toContain("github_pat_secret_token");
      expect(rendered).not.toContain("~/.agent-pool/data/agent-pool.db");
      expect(rendered).not.toContain("proxy-pass");
    }
    expect(preview).toContain("[redacted]");
    expect(rawLogs).toContain("[redacted-db-path]");
  });
});

function outputEvent(id: string, sequence: number, text: string) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    sessionId: "session-a",
    commandId: null,
    type: "session.output",
    payload: {
      stream: "stdout",
      sequence,
      text,
      observedAt: "2026-05-13T00:00:00.000Z",
    },
    createdAt: `2026-05-13T00:00:0${sequence}.000Z`,
  };
}

function readRawLogEntryForTest(id: string, text: string) {
  return {
    id,
    stream: "stdout",
    sequence: 1,
    text,
    observedAt: "2026-05-13T00:00:00.000Z",
    createdAt: "2026-05-13T00:00:01.000Z",
  };
}

function detailTask(): PublicTaskDetail {
  return {
    id: "task-a",
    projectId: "project-a",
    displayId: 1,
    title: "Task A",
    description: null,
    status: "running",
    priority: 0,
    runtimeSource: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    updatedAt: "2026-05-13T00:00:00.000Z",
    latestSession: null,
    pendingCommands: [],
    sessions: [],
    artifacts: [],
    events: [],
    logStreams: [],
    steeringMessages: [],
    notes: [],
  };
}

function session(
  id: string,
  attemptNumber: number,
  status: string,
  options: {
    readonly staleAt?: string | null;
    readonly runtimeSessionId?: string | null;
    readonly finalResponseText?: string | null;
    readonly finalResponseMetadata?: Readonly<Record<string, unknown>>;
    readonly finalResponseRecordedAt?: string | null;
  } = {},
) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    attemptNumber,
    status,
    runtimeProvider: "fake",
    runtimeSessionId: options.runtimeSessionId ?? null,
    sourceSnapshotId: null,
    createdAt: "2026-05-13T00:00:00.000Z",
    startedAt: "2026-05-13T00:01:00.000Z",
    endedAt: status === "succeeded" || status === "failed" ? "2026-05-13T00:03:00.000Z" : null,
    finalResponseText: options.finalResponseText ?? null,
    finalResponseMetadata: options.finalResponseMetadata ?? {},
    finalResponseRecordedAt: options.finalResponseRecordedAt ?? null,
    lastHeartbeatAt: "2026-05-13T00:02:30.000Z",
    heartbeatStatus: options.staleAt ? "stale" : "fresh",
    staleAt: options.staleAt ?? null,
    lostAt: null,
  };
}

function artifact(
  id: string,
  kind: string,
  uri: string,
  options: { readonly title?: string | null; readonly metadata?: Readonly<Record<string, unknown>> } = {},
) {
  return {
    id,
    projectId: "project-a",
    taskId: "task-a",
    sessionId: "session-a",
    kind,
    uri,
    title: options.title ?? null,
    metadata: options.metadata ?? {},
    createdAt: "2026-05-13T00:00:00.000Z",
  };
}

function evidenceArtifact(status: string, overrides: Readonly<Record<string, unknown>> = {}) {
  return artifact("artifact-evidence", "file", `storage://agent-pool-web-sandbox/evidence/${status}.json`, {
    title: `E2B smoke evidence ${status}`,
    metadata: evidenceMetadata({ status, ...overrides }),
  });
}

function evidenceMetadata(overrides: Readonly<Record<string, unknown>> = {}) {
  const evidence = {
    kind: "agent-pool-e2b-live-readiness-evidence",
    schemaVersion: 1,
    generatedAt: "2026-05-15T12:00:00.000Z",
    status: "pass",
    launchSpecHash: `sha256:${"a".repeat(64)}`,
    runtimeSource: {
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      baseRef: "main",
      taskBranchPrefix: "agent-pool/e2b-smoke/run-1",
      allowedEgressDomains: ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"],
      commandProfile: "agent-pool-bun-pr",
    },
    securityReadiness: {
      network: { egressMode: "proxy", proxyOnly: true },
      credentials: { github: "brokered-github-app-installation-token", rawSecretsPresent: false },
    },
    stageDiagnostics: null,
    cleanup: { provider: "e2b", sandboxId: "<runtime-session-id>", action: "destroy sandbox" },
    snapshotDecision: { status: "ready", reasons: [] },
    blockers: [],
    redaction: {
      containsNoServiceToken: true,
      containsNoGithubToken: true,
      containsNoE2BApiKey: true,
      containsNoCodexApiKey: true,
      containsNoProxyCredentials: true,
      containsNoBridgeOrSessionToken: true,
      containsNoLegacyTuiDbPath: true,
      containsNoApiDbPath: true,
    },
    ...overrides,
  };
  return {
    source: "smoke:e2b",
    evidenceKind: "agent-pool-e2b-live-readiness-evidence",
    evidenceStatus: evidence.status,
    validationStatus: evidence.status === "invalid" ? "invalid" : evidence.status === "blocked" ? "blocked" : "pass",
    generatedAt: evidence.generatedAt,
    launchSpecHash: evidence.launchSpecHash,
    blockers: evidence.blockers,
    evidence,
  };
}
