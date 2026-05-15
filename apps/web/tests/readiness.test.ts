import { describe, expect, test } from "bun:test";

import {
  getRuntimeReadinessMarkerClass,
  getVisibleRuntimeReadinessChecks,
  summarizeRuntimeReadiness,
} from "../src/readiness";
import type { PublicRuntimeReadinessStatus, PublicRuntimeReadinessSummary } from "../src/api";

describe("runtime readiness view model", () => {
  test("summarizes missing readiness data as an unknown browser-safe state", () => {
    const view = summarizeRuntimeReadiness(null);

    expect(view).toMatchObject({
      status: "unknown",
      tone: "unknown",
      statusLabel: "Unknown",
      markerClassName: "runtime-readiness-marker runtime-readiness-marker-unknown",
      missingPrerequisites: [],
      visibleChecks: [],
      links: [],
    });
  });

  test("prioritizes blockers, redacts unsafe prerequisite markers, and keeps links relative", () => {
    const view = summarizeRuntimeReadiness(
      readinessFixture({
        status: "blocked",
        missingPrerequisites: [
          "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID",
          "AGENT_POOL_WEB_SANDBOX_DB_PATH",
          "token=should-not-render",
        ],
        links: [
          { label: "Task", href: "/api/public/projects/compose-smoke/tasks/task-a", kind: "task" },
          { label: "External", href: "https://example.test/leak", kind: "api" },
        ],
      }),
    );

    expect(view.tone).toBe("blocked");
    expect(view.body).toBe("3 prerequisite(s) missing before live sandbox testing.");
    expect(view.missingPrerequisites).toEqual(["GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID"]);
    expect(view.visibleChecks.map((check) => check.id)).toEqual(["github-app", "egress", "template", "runtime"]);
    expect(view.links).toEqual([{ label: "Task", href: "/api/public/projects/compose-smoke/tasks/task-a", kind: "task" }]);
    expect(JSON.stringify(view)).not.toContain("WEB_SANDBOX_DB_PATH");
    expect(JSON.stringify(view)).not.toContain("token=should-not-render");
  });

  test("has stable responsive marker classes for every readiness status", () => {
    const statuses: readonly PublicRuntimeReadinessStatus[] = ["ready", "blocked", "warning", "unknown"];

    expect(statuses.map(getRuntimeReadinessMarkerClass)).toEqual([
      "runtime-readiness-marker runtime-readiness-marker-ready",
      "runtime-readiness-marker runtime-readiness-marker-blocked",
      "runtime-readiness-marker runtime-readiness-marker-warning",
      "runtime-readiness-marker runtime-readiness-marker-unknown",
    ]);
  });

  test("shows partial readiness checks without requiring smoke evidence", () => {
    const readiness = readinessFixture({
      status: "warning",
      checks: [
        {
          id: "egress",
          label: "Egress mode",
          status: "warn",
          detail: "Proxy-only egress is configured for smoke testing.",
          prerequisite: null,
          nextAction: null,
        },
        {
          id: "runtime",
          label: "Runtime provider",
          status: "pass",
          detail: "E2B is configured.",
          prerequisite: null,
          nextAction: null,
        },
      ],
      lastSmoke: {
        status: "missing",
        projectId: "compose-smoke",
        summary: "Smoke project has no tasks yet.",
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
          command: "bun run smoke:e2b -- --evidence --agent-runner-mode codex",
        },
        links: [],
      },
    });

    expect(summarizeRuntimeReadiness(readiness).body).toBe("Proxy-only egress is configured for smoke testing.");
    expect(getVisibleRuntimeReadinessChecks(readiness, 2).map((check) => check.status)).toEqual(["warn", "pass"]);
  });
});

function readinessFixture(
  overrides: Partial<PublicRuntimeReadinessSummary> = {},
): PublicRuntimeReadinessSummary {
  return {
    status: "ready",
    generatedAt: "2026-05-15T00:00:00.000Z",
    runtimeProvider: "e2b",
    agentRunnerMode: "codex",
    smokeProjectId: "compose-smoke",
    smokeEnabled: true,
    checks: [
      {
        id: "runtime",
        label: "Runtime provider",
        status: "pass",
        detail: "E2B is configured.",
        prerequisite: null,
        nextAction: null,
      },
      {
        id: "github-app",
        label: "GitHub App broker",
        status: "block",
        detail: "GitHub App broker is missing.",
        prerequisite: "GITHUB_APP_ID/GITHUB_APP_PRIVATE_KEY/GITHUB_APP_INSTALLATION_ID",
        nextAction: null,
      },
      {
        id: "egress",
        label: "Egress mode",
        status: "warn",
        detail: "Proxy-only egress is configured for smoke testing.",
        prerequisite: null,
        nextAction: null,
      },
      {
        id: "template",
        label: "Template",
        status: "unknown",
        detail: "Template compatibility has not been checked.",
        prerequisite: null,
        nextAction: null,
      },
    ],
    missingPrerequisites: [],
    warnings: ["Proxy-only egress is configured for smoke testing."],
    lastSmoke: {
      status: "available",
      projectId: "compose-smoke",
      summary: "Latest smoke task is completed.",
      taskId: "task-a",
      taskTitle: "Smoke",
      taskStatus: "completed",
      sessionId: "session-a",
      sessionStatus: "succeeded",
      runtimeProvider: "e2b",
      updatedAt: "2026-05-15T00:00:00.000Z",
      evidence: {
        status: "task-diagnostics",
        summary: "Task diagnostics are available.",
        command: "bun run smoke:e2b -- --evidence --agent-runner-mode codex",
      },
      links: [],
    },
    links: [],
    redaction: { secrets: "redacted", databasePaths: "omitted" },
    ...overrides,
  };
}
