import type { AppConfig } from "@agent-pool/config";
import type { CanonicalStateServices } from "@agent-pool/db";
import type { StorageAdapter } from "@agent-pool/storage";

export type SmokeEvidenceValidation = {
  readonly ok: boolean;
  readonly status: "pass" | "blocked" | "invalid";
  readonly errors: readonly string[];
  readonly redactionViolations: readonly string[];
};

export type PersistSmokeEvidenceInput = {
  readonly config: AppConfig;
  readonly services: Pick<CanonicalStateServices, "recordSmokeEvidenceArtifact">;
  readonly storage: StorageAdapter;
  readonly projectId?: string | null;
  readonly taskId?: string | null;
  readonly sessionId?: string | null;
  readonly evidence: unknown;
};

export type PersistSmokeEvidenceResult =
  | {
      readonly ok: true;
      readonly validation: SmokeEvidenceValidation;
      readonly artifact: {
        readonly id: string;
        readonly projectId: string;
        readonly taskId: string | null;
        readonly sessionId: string | null;
        readonly kind: string;
        readonly uri: string;
        readonly title: string | null;
      };
      readonly storage: {
        readonly adapter: StorageAdapter["kind"];
        readonly bucket: string;
        readonly key: string;
      };
      readonly idempotent: boolean;
    }
  | { readonly ok: false; readonly status: 400 | 404; readonly validation?: SmokeEvidenceValidation; readonly error: string };

export function persistSmokeEvidenceArtifact(input: PersistSmokeEvidenceInput): PersistSmokeEvidenceResult {
  const validation = validateSmokeEvidenceForArtifact(input.evidence);
  if (validation.status === "invalid") {
    return { ok: false, status: 400, validation, error: "invalid_smoke_evidence" };
  }

  const evidence = input.evidence as Readonly<Record<string, unknown>>;
  const projectId = input.projectId?.trim() || input.config.controlPlane.smokeProjectId;
  const taskId = input.taskId?.trim() || `${projectId}-task-1`;
  const sessionId = input.sessionId?.trim() || null;
  const evidenceStatus = readString(evidence.status) ?? "unknown";
  const launchSpecHash = readString(evidence.launchSpecHash) ?? "sha256-unknown";
  const object = input.storage.planObject([
    "projects",
    projectId,
    "tasks",
    taskId,
    ...(sessionId ? ["sessions", sessionId] : []),
    "evidence",
    `${evidenceStatus}-${launchSpecHash.replace(/[^a-zA-Z0-9.-]+/g, "-")}.json`,
  ]);
  const uri = `storage://${object.bucket}/${object.key}`;
  const metadata = {
    source: "smoke:e2b",
    evidenceKind: readString(evidence.kind),
    evidenceStatus,
    validationStatus: validation.status,
    generatedAt: readString(evidence.generatedAt),
    launchSpecHash,
    blockers: Array.isArray(evidence.blockers) ? evidence.blockers : [],
    storage: {
      adapter: object.adapter,
      bucket: object.bucket,
      key: object.key,
    },
    evidence,
  };
  const result = input.services.recordSmokeEvidenceArtifact({
    projectId,
    taskId,
    sessionId,
    uri,
    title: `E2B smoke evidence ${evidenceStatus}`,
    metadata,
  });

  if (!result.ok) {
    return { ok: false, status: 404, error: result.error.message };
  }

  return {
    ok: true,
    validation,
    artifact: result.artifact,
    storage: {
      adapter: object.adapter,
      bucket: object.bucket,
      key: object.key,
    },
    idempotent: result.idempotent,
  };
}

export function validateSmokeEvidenceForArtifact(input: unknown): SmokeEvidenceValidation {
  const evidence = readRecord(input);
  const errors: string[] = [];
  const redactionViolations = findRedactionViolations(input);
  if (!evidence) {
    return { ok: false, status: "invalid", errors: ["evidence must be a JSON object"], redactionViolations };
  }

  for (const field of ["kind", "schemaVersion", "generatedAt", "status", "launchSpecHash", "redaction"]) {
    if (!(field in evidence)) errors.push(`missing evidence field: ${field}`);
  }
  if (evidence.kind !== "agent-pool-e2b-live-readiness-evidence") {
    errors.push("kind must be agent-pool-e2b-live-readiness-evidence");
  }
  if (evidence.schemaVersion !== 1) {
    errors.push("schemaVersion must be 1");
  }
  if (!["dry-run", "pass", "blocked", "failed"].includes(String(evidence.status))) {
    errors.push("status must be dry-run, pass, blocked, or failed");
  }
  if (typeof evidence.launchSpecHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(evidence.launchSpecHash)) {
    errors.push("launchSpecHash must be a sha256 digest");
  }

  const redaction = readRecord(evidence.redaction);
  for (const flag of [
    "containsNoServiceToken",
    "containsNoGithubToken",
    "containsNoE2BApiKey",
    "containsNoCodexApiKey",
    "containsNoProxyCredentials",
    "containsNoBridgeOrSessionToken",
    "containsNoLegacyTuiDbPath",
    "containsNoApiDbPath",
  ]) {
    if (redaction?.[flag] !== true) redactionViolations.push(`redaction flag is not true: ${flag}`);
  }

  const blockers = Array.isArray(evidence.blockers) ? evidence.blockers : [];
  const status = errors.length > 0 || redactionViolations.length > 0
    ? "invalid"
    : evidence.status === "blocked" || blockers.length > 0
      ? "blocked"
      : "pass";

  return { ok: status !== "invalid", status, errors, redactionViolations };
}

function findRedactionViolations(value: unknown): string[] {
  const violations: string[] = [];
  visitStrings(value, (text) => {
    if (/~\/\.agent-pool\/data\/agent-pool\.db|\.agent-pool\/web-sandbox|web-sandbox\.db|AGENT_POOL_WEB_SANDBOX_DB_PATH/i.test(text)) {
      violations.push("evidence contains a backend or legacy database path");
    }
    if (/(?:ghp_|ghs_|github_pat_|sk-[A-Za-z0-9]|xox[baprs]-|BEGIN [A-Z ]*PRIVATE KEY|https?:\/\/[^/\s:]+:[^@\s]+@)/i.test(text)) {
      violations.push("evidence contains a token-like or credential-bearing value");
    }
    if (/(?:e2b-secret|codex-secret|service-secret|bridge-secret|github-app-private-key|proxy-secret|api-secret)/i.test(text)) {
      violations.push("evidence contains an unredacted test secret value");
    }
  });
  return [...new Set(violations)];
}

function visitStrings(value: unknown, visit: (value: string) => void): void {
  if (typeof value === "string") {
    visit(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) visitStrings(item, visit);
    return;
  }
  const record = readRecord(value);
  if (!record) return;
  for (const item of Object.values(record)) visitStrings(item, visit);
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}

function readString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
