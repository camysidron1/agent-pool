import { readFile } from "node:fs/promises";

export type ManualDemoCriterionStatus = "pending" | "pass" | "block";

export type ManualDemoEvidenceCriterion = {
  readonly id: string;
  readonly status: ManualDemoCriterionStatus;
  readonly label?: string;
  readonly evidence?: unknown;
  readonly blocker?: string;
};

export type ManualDemoEvidenceValidation = {
  readonly ok: boolean;
  readonly status: "pass" | "blocked" | "missing" | "invalid";
  readonly missingCriteria: readonly string[];
  readonly blockedCriteria: readonly string[];
  readonly redactionViolations: readonly string[];
  readonly errors: readonly string[];
};

export type ManualDemoEvidenceCliOptions = {
  readonly readFile?: (path: string) => Promise<string>;
  readonly write?: (text: string) => void;
};

const REQUIRED_CRITERIA = [
  "operator_selects_nebari_mvp",
  "operator_creates_task",
  "task_auto_starts_e2b",
  "task_in_progress_sse",
  "logs_stream",
  "steering_applies",
  "artifact_appears",
  "terminal_result_understandable",
  "sandbox_cleanup_occurs",
] as const;

const REDACTION_FLAGS = [
  "containsNoServiceToken",
  "containsNoGithubToken",
  "containsNoE2BApiKey",
  "containsNoBridgeOrSessionToken",
  "containsNoLegacyTuiDbPath",
  "containsNoApiDbPath",
] as const;

const SECRET_FIELD_NAMES = new Set([
  "serviceToken",
  "bridgeToken",
  "sessionToken",
  "apiKey",
]);

const SECRET_VALUE_PATTERNS: readonly RegExp[] = [
  /ghp_[A-Za-z0-9_]{20,}/,
  /github_pat_[A-Za-z0-9_]{20,}/,
  /e2b_[A-Za-z0-9_-]{20,}/,
  /xox[baprs]-[A-Za-z0-9-]{10,}/,
  /sk-[A-Za-z0-9_-]{20,}/,
];

const FORBIDDEN_PATH_PATTERNS: readonly RegExp[] = [
  /~\/\.agent-pool\/data\/agent-pool\.db/,
  /\.agent-pool\/data\/agent-pool\.db/,
  /\/var\/lib\/agent-pool\/web-sandbox\.db/,
  /AGENT_POOL_WEB_SANDBOX_DB_PATH/,
];

export function validateManualDemoEvidence(input: unknown): ManualDemoEvidenceValidation {
  const evidence = readRecord(input);
  if (!evidence) {
    return {
      ok: false,
      status: "invalid",
      missingCriteria: [...REQUIRED_CRITERIA],
      blockedCriteria: [],
      redactionViolations: [],
      errors: ["evidence must be a JSON object"],
    };
  }

  const criteria = readCriteria(evidence.criteria);
  const criteriaById = new Map(criteria.map((criterion) => [criterion.id, criterion]));
  const missingCriteria = REQUIRED_CRITERIA.filter((id) => criteriaById.get(id)?.status !== "pass" && criteriaById.get(id)?.status !== "block");
  const blockedCriteria = REQUIRED_CRITERIA.filter((id) => criteriaById.get(id)?.status === "block");
  const errors: string[] = [];

  if (evidence.phaseId !== "14") errors.push("phaseId must be 14");
  if (typeof evidence.demoName !== "string" || !evidence.demoName.includes("nebari-mvp")) {
    errors.push("demoName must identify the nebari-mvp demo");
  }
  if (!["pending", "pass", "blocked"].includes(String(evidence.status))) {
    errors.push("status must be pending, pass, or blocked");
  }

  const redactionViolations = findRedactionViolations(input);
  const redaction = readRecord(evidence.redaction);
  for (const flag of REDACTION_FLAGS) {
    if (redaction?.[flag] !== true) {
      redactionViolations.push(`redaction flag is not true: ${flag}`);
    }
  }

  const status = resolveStatus({
    errors,
    missingCriteria,
    blockedCriteria,
    redactionViolations,
  });

  return {
    ok: status === "pass",
    status,
    missingCriteria,
    blockedCriteria,
    redactionViolations,
    errors,
  };
}

export async function runManualDemoEvidenceCli(
  args: readonly string[] = process.argv.slice(2),
  options: ManualDemoEvidenceCliOptions = {},
): Promise<number> {
  const evidencePath = args[0];
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const read = options.readFile ?? readFileText;

  if (!evidencePath) {
    write(`${JSON.stringify({ ok: false, status: "invalid", errors: ["usage: demo:evidence <evidence.json>"] }, null, 2)}\n`);
    return 1;
  }

  try {
    const text = await read(evidencePath);
    const validation = validateManualDemoEvidence(JSON.parse(text));
    write(`${JSON.stringify(validation, null, 2)}\n`);
    return validation.ok ? 0 : 1;
  } catch (error) {
    write(`${JSON.stringify({ ok: false, status: "invalid", errors: [errorMessage(error)] }, null, 2)}\n`);
    return 1;
  }
}

function readCriteria(value: unknown): readonly ManualDemoEvidenceCriterion[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((candidate) => {
      const record = readRecord(candidate);
      if (!record || typeof record.id !== "string") return null;
      if (record.status !== "pending" && record.status !== "pass" && record.status !== "block") return null;

      return {
        id: record.id,
        status: record.status,
        label: typeof record.label === "string" ? record.label : undefined,
        evidence: record.evidence,
        blocker: typeof record.blocker === "string" ? record.blocker : undefined,
      };
    })
    .filter((criterion): criterion is ManualDemoEvidenceCriterion => criterion !== null);
}

function findRedactionViolations(value: unknown): string[] {
  const violations: string[] = [];
  const serialized = JSON.stringify(value);

  for (const pattern of FORBIDDEN_PATH_PATTERNS) {
    if (pattern.test(serialized)) {
      violations.push(`forbidden path matched: ${pattern.source}`);
    }
  }

  visit(value, []);
  return violations;

  function visit(current: unknown, path: readonly string[]): void {
    if (typeof current === "string") {
      for (const pattern of SECRET_VALUE_PATTERNS) {
        if (pattern.test(current)) {
          violations.push(`secret-like value at ${path.join(".") || "<root>"}`);
        }
      }
      return;
    }

    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }

    const record = readRecord(current);
    if (!record) return;

    for (const [key, child] of Object.entries(record)) {
      if (SECRET_FIELD_NAMES.has(key) && typeof child === "string" && child.trim() !== "" && child !== "<redacted>") {
        violations.push(`secret field must be redacted: ${[...path, key].join(".")}`);
      }
      visit(child, [...path, key]);
    }
  }
}

function resolveStatus(input: {
  readonly errors: readonly string[];
  readonly missingCriteria: readonly string[];
  readonly blockedCriteria: readonly string[];
  readonly redactionViolations: readonly string[];
}): ManualDemoEvidenceValidation["status"] {
  if (input.errors.length > 0 || input.redactionViolations.length > 0) return "invalid";
  if (input.missingCriteria.length > 0) return "missing";
  if (input.blockedCriteria.length > 0) return "blocked";
  return "pass";
}

async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const code = await runManualDemoEvidenceCli();
  process.exit(code);
}
