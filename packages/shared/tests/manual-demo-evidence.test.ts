import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { runManualDemoEvidenceCli, validateManualDemoEvidence } from "../../../deploy/kubernetes/manual-demo-evidence";

describe("manual demo evidence validator", () => {
  test("accepts complete redacted Phase 14 evidence", async () => {
    const validation = validateManualDemoEvidence(passingEvidence());

    expect(validation).toEqual({
      ok: true,
      status: "pass",
      missingCriteria: [],
      blockedCriteria: [],
      redactionViolations: [],
      errors: [],
    });
  });

  test("reports blocked evidence with concrete criteria", () => {
    const evidence = passingEvidence({
      status: "blocked",
      criteria: requiredCriteria().map((criterion) =>
        criterion.id === "task_auto_starts_e2b"
          ? { ...criterion, status: "block", blocker: "E2B template missing" }
          : criterion,
      ),
      blockers: [{ field: "E2B_TEMPLATE_ID", reason: "missing" }],
    });

    expect(validateManualDemoEvidence(evidence)).toMatchObject({
      ok: false,
      status: "blocked",
      missingCriteria: [],
      blockedCriteria: ["task_auto_starts_e2b"],
      redactionViolations: [],
      errors: [],
    });
  });

  test("reports missing criteria separately from blockers", () => {
    const evidence = passingEvidence({
      criteria: requiredCriteria().filter((criterion) => criterion.id !== "artifact_appears"),
    });

    expect(validateManualDemoEvidence(evidence)).toMatchObject({
      ok: false,
      status: "missing",
      missingCriteria: ["artifact_appears"],
      blockedCriteria: [],
      redactionViolations: [],
      errors: [],
    });
  });

  test("rejects token-like values and backend database paths", () => {
    const evidence = passingEvidence({
      commandsRun: [
        "bun run smoke:e2b --service-token ghp_abcdefghijklmnopqrstuvwxyz123456",
        "sqlite path /var/lib/agent-pool/web-sandbox.db",
      ],
      redaction: {
        containsNoServiceToken: true,
        containsNoGithubToken: true,
        containsNoE2BApiKey: true,
        containsNoBridgeOrSessionToken: true,
        containsNoLegacyTuiDbPath: true,
        containsNoApiDbPath: true,
      },
    });
    const validation = validateManualDemoEvidence(evidence);

    expect(validation.ok).toBe(false);
    expect(validation.status).toBe("invalid");
    expect(validation.redactionViolations).toContain("forbidden path matched: \\/var\\/lib\\/agent-pool\\/web-sandbox\\.db");
    expect(validation.redactionViolations.some((violation) => violation.startsWith("secret-like value at commandsRun.0"))).toBe(true);
  });

  test("rejects false redaction flags", () => {
    const evidence = passingEvidence({
      redaction: {
        containsNoServiceToken: true,
        containsNoGithubToken: true,
        containsNoE2BApiKey: false,
        containsNoBridgeOrSessionToken: true,
        containsNoLegacyTuiDbPath: true,
        containsNoApiDbPath: true,
      },
    });

    expect(validateManualDemoEvidence(evidence)).toMatchObject({
      ok: false,
      status: "invalid",
      redactionViolations: ["redaction flag is not true: containsNoE2BApiKey"],
    });
  });

  test("runs as an offline CLI over an evidence JSON file", async () => {
    const writes: string[] = [];
    const code = await runManualDemoEvidenceCli(["evidence.json"], {
      write: (text) => writes.push(text),
      readFile: async () => JSON.stringify(passingEvidence()),
    });

    expect(code).toBe(0);
    expect(JSON.parse(writes.join(""))).toMatchObject({ ok: true, status: "pass" });
  });

  test("keeps the evidence validator out of the default test script", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts?: Record<string, string>;
    };
    const scripts = packageJson.scripts ?? {};

    expect(scripts.test).toBe("bun test apps packages");
    expect(scripts.test).not.toMatch(/demo:evidence|manual-demo|smoke:e2b|kubernetes/i);
    expect(scripts["demo:evidence"]).toBe("bun run deploy/kubernetes/manual-demo-evidence.ts");
  });
});

function requiredCriteria(): Array<{ id: string; status: "pass"; evidence: Record<string, string> }> {
  return [
    "operator_selects_nebari_mvp",
    "operator_creates_task",
    "task_auto_starts_e2b",
    "task_in_progress_sse",
    "logs_stream",
    "steering_applies",
    "artifact_appears",
    "terminal_result_understandable",
    "sandbox_cleanup_occurs",
  ].map((id) => ({ id, status: "pass", evidence: { observedAt: "2026-05-13T00:00:00.000Z" } }));
}

function passingEvidence(overrides: Record<string, unknown> = {}) {
  return {
    phaseId: "14",
    demoName: "nebari-mvp manual E2B demo",
    status: "pass",
    criteria: requiredCriteria(),
    project: { id: "project_nebari_mvp", name: "nebari-mvp", selectedInWeb: true },
    task: { id: "task_1", displayId: 1, creationMethod: "direct-create" },
    session: { id: "session_1", runtimeProvider: "e2b", runtimeSessionId: "<redacted>" },
    sse: { observedEventTypes: ["task.created", "session.started"] },
    logs: { lineCount: 3, byteOffset: 128, redactedSummary: "startup and task output observed" },
    steering: { messageId: "steering_1", commandId: "command_1", status: "delivered" },
    artifacts: [{ id: "artifact_1", kind: "document", title: "result.md", uri: "<redacted>" }],
    finalOutcome: { status: "completed", finalResponseText: "completed", blockingReason: null },
    cleanup: { commandId: "cleanup_1", status: "completed" },
    blockers: [],
    commandsRun: ["bun run smoke:e2b --api-url https://api.example.com --service-token <redacted>"],
    redaction: {
      containsNoServiceToken: true,
      containsNoGithubToken: true,
      containsNoE2BApiKey: true,
      containsNoBridgeOrSessionToken: true,
      containsNoLegacyTuiDbPath: true,
      containsNoApiDbPath: true,
    },
    ...overrides,
  };
}
