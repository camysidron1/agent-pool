import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { loadConfig, type EnvSource } from "@agent-pool/config";
import {
  AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_DIGEST,
  buildE2BLaunchSpec,
  buildGitHubBootstrapPlan,
  buildSandboxBridgeStartupPlan,
  redactE2BLaunchSpec,
  type RedactedE2BLaunchSpec,
  type RuntimeTaskSourceMetadata,
} from "@agent-pool/runtime";

import { loadLocalEnv, readProcessEnv } from "../local-env";

export type E2BSmokeRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
  readonly body?: unknown;
};

export type E2BSmokePlan = {
  readonly runtimeProvider: "e2b";
  readonly apiUrl: string;
  readonly timeoutMs: number;
  readonly serviceTokenHeaderName: string;
  readonly serviceToken: "[REDACTED]" | "[MISSING]";
  readonly missingCredentials: readonly string[];
  readonly missingSettings: readonly string[];
  readonly runtimeSource: RuntimeTaskSourceMetadata;
  readonly launchSpec: RedactedE2BLaunchSpec;
  readonly bootstrap: ReturnType<typeof buildGitHubBootstrapPlan>;
  readonly bridgeStartup: ReturnType<typeof buildSandboxBridgeStartupPlan>["redactedEnv"];
  readonly securityReadiness: E2BSmokeSecurityReadiness;
  readonly cleanup: {
    readonly provider: "e2b";
    readonly sandboxId: "<runtime-session-id>";
    readonly timeoutMs: number;
    readonly action: "destroy sandbox through RuntimeProvider.stopSession";
  };
  readonly maliciousFixtures: {
    readonly enabled: boolean;
    readonly liveExecution: "not_requested" | "dry_run_only" | "skipped_until_live_runner_is_ready";
    readonly fixtureIds: readonly string[];
  };
  readonly requests: {
    readonly callbackHealth: E2BSmokeRequest;
    readonly githubAppVerify: E2BSmokeRequest;
    readonly seed: E2BSmokeRequest;
    readonly status: E2BSmokeRequest;
  };
};

export type E2BSmokeSecurityReadiness = {
  readonly execution: {
    readonly defaultTests: "fake-provider-safe";
    readonly liveE2B: "opt-in";
    readonly packageProxySmoke: "opt-in";
  };
  readonly network: {
    readonly egressMode: "proxy" | "test-direct";
    readonly proxyOnly: boolean;
    readonly allowInternetAccess: boolean;
    readonly allowPublicTraffic: boolean;
    readonly allowOut: readonly string[];
    readonly packageProxyMode: string | null;
    readonly packageProxyUrl: string | null;
  };
  readonly commandPolicy: {
    readonly profile: string | null;
    readonly enforcedBy: readonly string[];
  };
  readonly credentials: {
    readonly github: "brokered-github-app-installation-token";
    readonly codex: "env-api-key";
    readonly redactedSecretNames: readonly string[];
    readonly rawSecretsPresent: false;
  };
  readonly snapshotPolicy: {
    readonly successSnapshots: "clean-terminal-sessions-only";
    readonly blockedBy: readonly string[];
    readonly cleanupAction: "destroy sandbox through RuntimeProvider.stopSession";
  };
  readonly liveSmokePrerequisites: {
    readonly missingCredentials: readonly string[];
    readonly missingSettings: readonly string[];
  };
};

export type E2BSmokeCliOptions = {
  readonly cwd?: string;
  readonly env?: EnvSource;
  readonly write?: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly readFile?: (path: string) => Promise<string>;
};

export type E2BReadinessStatus = "ready" | "blocked" | "warning";

export type E2BReadinessCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "block" | "warn";
  readonly detail: string;
  readonly nextAction: string | null;
};

export type E2BCallbackReachabilityResult = {
  readonly ok: boolean;
  readonly status: "reachable" | "local-only" | "wrong-protocol" | "not-found" | "auth-failed" | "timeout" | "error";
  readonly url: string;
  readonly httpStatus: number | null;
  readonly detail: string;
  readonly nextAction: string | null;
};

export type E2BSmokeDiagnosticStage =
  | "readiness"
  | "seed"
  | "claim"
  | "sandbox-create"
  | "bootstrap-clone"
  | "install"
  | "codex"
  | "pr"
  | "cleanup"
  | "snapshot";

export type E2BEvidenceBundle = {
  readonly kind: "agent-pool-e2b-live-readiness-evidence";
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly status: "dry-run" | "pass" | "blocked" | "failed";
  readonly readinessSummary: {
    readonly status: E2BReadinessStatus | null;
    readonly missingCredentials: readonly string[];
    readonly missingSettings: readonly string[];
    readonly blockedChecks: readonly string[];
  };
  readonly launchSpecHash: string;
  readonly redactedLaunchSpec: RedactedE2BLaunchSpec;
  readonly runtimeSource: RuntimeTaskSourceMetadata;
  readonly securityReadiness: E2BSmokeSecurityReadiness;
  readonly smokeRequests: E2BSmokePlan["requests"];
  readonly statusResult: unknown;
  readonly stageDiagnostics: unknown;
  readonly cleanup: E2BSmokePlan["cleanup"];
  readonly snapshotDecision: {
    readonly status: string;
    readonly reasons: readonly string[];
  };
  readonly blockers: readonly { readonly field: string; readonly reason: string }[];
  readonly redaction: {
    readonly containsNoServiceToken: true;
    readonly containsNoGithubToken: true;
    readonly containsNoE2BApiKey: true;
    readonly containsNoCodexApiKey: true;
    readonly containsNoProxyCredentials: true;
    readonly containsNoBridgeOrSessionToken: true;
    readonly containsNoLegacyTuiDbPath: true;
    readonly containsNoApiDbPath: true;
  };
};

export type E2BEvidenceValidation = {
  readonly ok: boolean;
  readonly status: "pass" | "blocked" | "invalid";
  readonly missingFields: readonly string[];
  readonly blockers: readonly string[];
  readonly redactionViolations: readonly string[];
  readonly errors: readonly string[];
};

export type E2BReadinessReport = {
  readonly ok: true;
  readonly kind: "e2b-readiness";
  readonly status: E2BReadinessStatus;
  readonly agentRunnerMode: "bridge-smoke" | "codex";
  readonly sideEffects: readonly [];
  readonly nextAction: string;
  readonly missingCredentials: readonly string[];
  readonly missingSettings: readonly string[];
  readonly runtimeSource: RuntimeTaskSourceMetadata;
  readonly securityReadiness: E2BSmokeSecurityReadiness;
  readonly callbackReachability?: E2BCallbackReachabilityResult;
  readonly checks: readonly E2BReadinessCheck[];
};

type ParsedE2BSmokeArgs = {
  readonly dryRun: boolean;
  readonly readiness: boolean;
  readonly apiUrl: string;
  readonly serviceToken?: string;
  readonly timeoutMs: number;
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
  readonly agentRunnerMode?: "bridge-smoke" | "codex";
  readonly allowedEgressDomains?: readonly string[];
  readonly maliciousFixtures: boolean;
  readonly verifyCallback: boolean;
  readonly callbackTimeoutMs: number;
  readonly evidence: boolean;
  readonly validateEvidencePath?: string;
};

const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_REPOSITORY_URL = "https://github.com/example/tiny-fixture.git";
const DEFAULT_BASE_REF = "main";
const DEFAULT_TASK_BRANCH_PREFIX = "agent-pool/e2b-smoke";
const DEFAULT_ALLOWED_EGRESS_DOMAINS = ["github.com", "api.github.com", "registry.npmjs.org", "api.openai.com"] as const;
const DRY_RUN_TEMPLATE_ID = "dry-run-template";
const DRY_RUN_GITHUB_TOKEN = "dry-run-github-token";
const DRY_RUN_CODEX_API_KEY = "dry-run-codex-api-key";
const DRY_RUN_EGRESS_PROXY_URL = "http://dry-run-egress-proxy.invalid:8080";
const DRY_RUN_EGRESS_ALLOW_OUT = ["127.0.0.1/32"] as const;
const DRY_RUN_SESSION_TOKEN = "dry-run-session-token";
const DEFAULT_COMPOSE_SERVICE_TOKEN = "compose-internal-service-token";
const DEFAULT_CALLBACK_REACHABILITY_TIMEOUT_MS = 5_000;
const MALICIOUS_FIXTURE_IDS = [
  "postinstall-lifecycle-script",
  "unexpected-package-add",
  "lockfile-mutation",
  "undeclared-egress",
  "token-file-read",
  "gh-auth-token",
  "metadata-instruction-injection",
  "credential-persistence",
] as const;

class E2BSmokeStageError extends Error {
  readonly stage: E2BSmokeDiagnosticStage;
  readonly diagnostics: unknown;

  constructor(stage: E2BSmokeDiagnosticStage, message: string, diagnostics?: unknown) {
    super(message);
    this.name = "E2BSmokeStageError";
    this.stage = stage;
    this.diagnostics = diagnostics ?? null;
  }
}

export function createE2BSmokePlan(input: Partial<ParsedE2BSmokeArgs> & { readonly env?: EnvSource } = {}): E2BSmokePlan {
  const env = input.env ?? readProcessEnv();
  const agentRunnerMode = readAgentRunnerMode(input.agentRunnerMode ?? env.AGENT_RUNNER_MODE);
  const config = loadConfig(buildE2BSmokeConfigEnv(env, agentRunnerMode));
  const e2b = config.controlPlane.e2b;
  const allowedEgressDomains = input.allowedEgressDomains ?? readAllowedEgressDomains(env.AGENT_POOL_ALLOWED_EGRESS_DOMAINS);
  const runtimeSource = {
    repositoryUrl: input.repositoryUrl ?? DEFAULT_REPOSITORY_URL,
    baseRef: input.baseRef ?? DEFAULT_BASE_REF,
    taskBranchPrefix: input.taskBranchPrefix ?? DEFAULT_TASK_BRANCH_PREFIX,
    ...(agentRunnerMode === "codex"
      ? {
          allowedEgressDomains,
          commandProfile: e2b.codexCommandProfile,
        }
      : {}),
  };
  const apiUrl = trimTrailingSlash(input.apiUrl ?? DEFAULT_API_URL);
  const serviceToken = input.serviceToken ?? config.serviceToken.token;
  const missingCredentials = readMissingCredentials(env, e2b, agentRunnerMode);
  const missingSettings = readMissingSettings(e2b, agentRunnerMode, allowedEgressDomains);
  const allowedSecretEnvNames = [
    ...new Set([
      ...e2b.allowedSecretEnvNames,
      e2b.githubTokenEnvName,
      ...(agentRunnerMode === "codex" ? [e2b.codexApiKeyEnvName] : []),
    ]),
  ];
  const launchConfig = {
    ...e2b,
    apiKeyConfigured: true,
    githubTokenConfigured: true,
    templateId: e2b.templateId ?? DRY_RUN_TEMPLATE_ID,
    templateCompatibilityManifest: readTemplateCompatibilityManifest(env),
    templateCompatibilityDigest: env.E2B_TEMPLATE_COMPATIBILITY_DIGEST?.trim() || null,
    allowedSecretEnvNames,
    ...(agentRunnerMode === "codex" && !e2b.localAllowDirectEgress && (!e2b.egressProxyUrl || e2b.egressProxyAllowOut.length === 0)
      ? {
          egressProxyUrl: e2b.egressProxyUrl ?? DRY_RUN_EGRESS_PROXY_URL,
          egressProxyAllowOut: e2b.egressProxyAllowOut.length > 0 ? e2b.egressProxyAllowOut : DRY_RUN_EGRESS_ALLOW_OUT,
        }
      : {}),
  };
  const launchSpec = buildE2BLaunchSpec(
    {
      projectId: config.controlPlane.smokeProjectId,
      taskId: `${config.controlPlane.smokeProjectId}-task-1`,
      sessionId: "e2b-smoke-session",
      task: {
        runtimeSource,
      },
      bridge: {
        projectId: config.controlPlane.smokeProjectId,
        taskId: `${config.controlPlane.smokeProjectId}-task-1`,
        sessionId: "e2b-smoke-session",
        callbackBaseUrl: config.bridge.callbackBaseUrl,
        sessionToken: {
          headerName: config.bridge.sessionTokenHeaderName,
          token: DRY_RUN_SESSION_TOKEN,
        },
        workspaceRoot: e2b.workingDirectory,
      },
      secretEnvironment: {
        [e2b.githubTokenEnvName]: env[e2b.githubTokenEnvName]?.trim() || DRY_RUN_GITHUB_TOKEN,
        ...(agentRunnerMode === "codex"
          ? { [e2b.codexApiKeyEnvName]: env[e2b.codexApiKeyEnvName]?.trim() || DRY_RUN_CODEX_API_KEY }
          : {}),
      },
    },
    {
      config: launchConfig,
      env: {
        ...env,
        [e2b.githubTokenEnvName]: env[e2b.githubTokenEnvName]?.trim() || DRY_RUN_GITHUB_TOKEN,
        ...(agentRunnerMode === "codex"
          ? { [e2b.codexApiKeyEnvName]: env[e2b.codexApiKeyEnvName]?.trim() || DRY_RUN_CODEX_API_KEY }
          : {}),
      },
      secretEnvNames: agentRunnerMode === "codex" ? [e2b.githubTokenEnvName, e2b.codexApiKeyEnvName] : [e2b.githubTokenEnvName],
    },
  );
  const bootstrap = buildGitHubBootstrapPlan({
    runtimeSource,
    taskId: `${config.controlPlane.smokeProjectId}-task-1`,
    workingDirectory: launchSpec.sandbox.workingDirectory,
    githubTokenEnvName: e2b.githubTokenEnvName,
    githubTokenConfigured: true,
  });
  const bridgeStartup = buildSandboxBridgeStartupPlan(launchSpec);
  const redactedLaunchSpec = redactE2BLaunchSpec(launchSpec);
  const cleanup = {
    provider: "e2b" as const,
    sandboxId: "<runtime-session-id>" as const,
    timeoutMs: e2b.cleanupTimeoutMs,
    action: "destroy sandbox through RuntimeProvider.stopSession" as const,
  };
  const maliciousFixtures = {
    enabled: input.maliciousFixtures === true,
    liveExecution:
      input.maliciousFixtures === true
        ? input.dryRun === true
          ? "dry_run_only" as const
          : "skipped_until_live_runner_is_ready" as const
        : "not_requested" as const,
    fixtureIds: input.maliciousFixtures === true ? MALICIOUS_FIXTURE_IDS : [],
  };

  return {
    runtimeProvider: "e2b",
    apiUrl,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    serviceTokenHeaderName: config.serviceToken.headerName,
    serviceToken: serviceToken.trim() ? "[REDACTED]" : "[MISSING]",
    missingCredentials,
    missingSettings,
    runtimeSource,
    launchSpec: redactedLaunchSpec,
    bootstrap,
    bridgeStartup: bridgeStartup.redactedEnv,
    securityReadiness: buildSecurityReadiness({
      launchSpec: redactedLaunchSpec,
      cleanup,
      missingCredentials,
      missingSettings,
    }),
    cleanup,
    maliciousFixtures,
    requests: {
      callbackHealth: {
        method: "GET",
        url: `${trimTrailingSlash(config.bridge.callbackBaseUrl)}/health`,
      },
      githubAppVerify: {
        method: "POST",
        url: `${apiUrl}/internal/orchestrator/github-app/verify`,
        body: {
          repositoryUrl: runtimeSource.repositoryUrl,
        },
      },
      seed: {
        method: "POST",
        url: `${apiUrl}/internal/smoke/seed`,
        body: {
          runtimeSource,
        },
      },
      status: {
        method: "GET",
        url: `${apiUrl}/internal/smoke/status`,
      },
    },
  };
}

export function createE2BReadinessReport(input: Partial<ParsedE2BSmokeArgs> & { readonly env?: EnvSource } = {}): E2BReadinessReport {
  const agentRunnerMode = readAgentRunnerMode(input.agentRunnerMode ?? input.env?.AGENT_RUNNER_MODE);
  const plan = createE2BSmokePlan({ ...input, agentRunnerMode });
  const checks = buildReadinessChecks(plan, agentRunnerMode);
  const status = summarizeReadinessStatus(checks);

  return {
    ok: true,
    kind: "e2b-readiness",
    status,
    agentRunnerMode,
    sideEffects: [],
    nextAction: nextReadinessAction(status),
    missingCredentials: plan.missingCredentials,
    missingSettings: plan.missingSettings,
    runtimeSource: plan.runtimeSource,
    securityReadiness: plan.securityReadiness,
    checks,
  };
}

export function createE2BEvidenceBundle(input: {
  readonly plan: E2BSmokePlan;
  readonly status: E2BEvidenceBundle["status"];
  readonly generatedAt?: string;
  readonly readinessReport?: E2BReadinessReport | null;
  readonly statusResult?: unknown;
  readonly stageDiagnostics?: unknown;
  readonly error?: string | null;
}): E2BEvidenceBundle {
  const stageDiagnostics = input.stageDiagnostics ?? readSmokeStatusDiagnostics(input.statusResult);
  return {
    kind: "agent-pool-e2b-live-readiness-evidence",
    schemaVersion: 1,
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    status: input.status,
    readinessSummary: {
      status: input.readinessReport?.status ?? null,
      missingCredentials: input.plan.missingCredentials,
      missingSettings: input.plan.missingSettings,
      blockedChecks: input.readinessReport?.checks.filter((check) => check.status === "block").map((check) => check.id) ?? [],
    },
    launchSpecHash: stableSha256(input.plan.launchSpec),
    redactedLaunchSpec: input.plan.launchSpec,
    runtimeSource: input.plan.runtimeSource,
    securityReadiness: input.plan.securityReadiness,
    smokeRequests: input.plan.requests,
    statusResult: redactEvidenceValue(input.statusResult ?? null),
    stageDiagnostics: redactEvidenceValue(stageDiagnostics),
    cleanup: input.plan.cleanup,
    snapshotDecision: readSnapshotDecision(stageDiagnostics),
    blockers: buildEvidenceBlockers(input.plan, input.readinessReport, input.error),
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
  };
}

export function validateE2BEvidenceBundle(input: unknown): E2BEvidenceValidation {
  const evidence = readRecord(input);
  if (!evidence) {
    return {
      ok: false,
      status: "invalid",
      missingFields: ["<root>"],
      blockers: [],
      redactionViolations: [],
      errors: ["evidence must be a JSON object"],
    };
  }
  const requiredFields = [
    "kind",
    "schemaVersion",
    "generatedAt",
    "status",
    "readinessSummary",
    "launchSpecHash",
    "runtimeSource",
    "securityReadiness",
    "smokeRequests",
    "stageDiagnostics",
    "cleanup",
    "snapshotDecision",
    "blockers",
    "redaction",
  ];
  const missingFields = requiredFields.filter((field) => !(field in evidence));
  const errors: string[] = [];
  if (evidence.kind !== "agent-pool-e2b-live-readiness-evidence") errors.push("kind must be agent-pool-e2b-live-readiness-evidence");
  if (evidence.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (!["dry-run", "pass", "blocked", "failed"].includes(String(evidence.status))) errors.push("status must be dry-run, pass, blocked, or failed");
  if (typeof evidence.launchSpecHash !== "string" || !/^sha256:[a-f0-9]{64}$/.test(evidence.launchSpecHash)) {
    errors.push("launchSpecHash must be a sha256 digest");
  }
  const blockers = readBlockerReasons(evidence.blockers);
  const redactionViolations = findEvidenceRedactionViolations(input);
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
  const status = errors.length > 0 || missingFields.length > 0 || redactionViolations.length > 0
    ? "invalid"
    : evidence.status === "blocked" || blockers.length > 0
      ? "blocked"
      : "pass";
  return {
    ok: status === "pass",
    status,
    missingFields,
    blockers,
    redactionViolations,
    errors,
  };
}

function withCallbackReachability(report: E2BReadinessReport, callbackReachability: E2BCallbackReachabilityResult): E2BReadinessReport {
  const checks = [
    ...report.checks,
    {
      id: "callback-reachability",
      label: "Callback reachability",
      status: callbackReachability.ok ? "pass" as const : "block" as const,
      detail: callbackReachability.detail,
      nextAction: callbackReachability.nextAction,
    },
  ];
  const status = summarizeReadinessStatus(checks);
  return {
    ...report,
    status,
    nextAction: nextReadinessAction(status),
    callbackReachability,
    checks,
  };
}

function summarizeReadinessStatus(checks: readonly E2BReadinessCheck[]): E2BReadinessStatus {
  const hasBlocks = checks.some((check) => check.status === "block");
  const hasWarnings = checks.some((check) => check.status === "warn");
  return hasBlocks ? "blocked" : hasWarnings ? "warning" : "ready";
}

function stableSha256(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex")}`;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const record = readRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sortJson(record[key])]));
}

function buildEvidenceBlockers(
  plan: E2BSmokePlan,
  readinessReport: E2BReadinessReport | null | undefined,
  error: string | null | undefined,
): readonly { readonly field: string; readonly reason: string }[] {
  return [
    ...plan.missingCredentials.map((field) => ({ field, reason: "missing credential" })),
    ...plan.missingSettings.map((field) => ({ field, reason: "missing setting" })),
    ...(readinessReport?.checks.filter((check) => check.status === "block").map((check) => ({ field: check.id, reason: check.detail })) ?? []),
    ...(error ? [{ field: "smoke:e2b", reason: redactEvidenceString(error) }] : []),
  ];
}

function readSnapshotDecision(stageDiagnostics: unknown): E2BEvidenceBundle["snapshotDecision"] {
  const diagnostics = readRecord(stageDiagnostics);
  const stages = Array.isArray(diagnostics?.stages) ? diagnostics.stages : [];
  const snapshot = stages.map(readRecord).find((stage) => stage?.id === "snapshot");
  const status = typeof snapshot?.status === "string" ? snapshot.status : "not_observed";
  const detail = typeof snapshot?.detail === "string" ? [redactEvidenceString(snapshot.detail)] : [];
  return { status, reasons: detail };
}

function readBlockerReasons(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map(readRecord)
    .map((record) => {
      const field = typeof record?.field === "string" ? record.field : null;
      const reason = typeof record?.reason === "string" ? record.reason : null;
      return field && reason ? `${field}: ${reason}` : null;
    })
    .filter((reason): reason is string => reason !== null);
}

function redactEvidenceValue(value: unknown): unknown {
  if (typeof value === "string") return redactEvidenceString(value);
  if (Array.isArray(value)) return value.map(redactEvidenceValue);
  const record = readRecord(value);
  if (!record) return value;
  return Object.fromEntries(Object.entries(record).map(([key, child]) => [
    key,
    /token|secret|password|apiKey|privateKey|proxyUrl/i.test(key) ? redactEvidenceString(String(child)) : redactEvidenceValue(child),
  ]));
}

function redactEvidenceString(value: string): string {
  return value
    .replace(/~\/\.agent-pool\/data\/agent-pool\.db/g, "[REDACTED_DB_PATH]")
    .replace(/\/Users\/[^\s"']+\/\.agent-pool\/data\/agent-pool\.db/g, "[REDACTED_DB_PATH]")
    .replace(/\/var\/lib\/agent-pool\/web-sandbox\.db/g, "[REDACTED_DB_PATH]")
    .replace(/\b(?:ghp|ghs|github_pat)_[A-Za-z0-9_]+/g, "[REDACTED_GITHUB_TOKEN]")
    .replace(/\be2b_[A-Za-z0-9_-]{10,}/g, "[REDACTED_E2B_KEY]")
    .replace(/\bsk-[A-Za-z0-9_-]{10,}/g, "[REDACTED_CODEX_KEY]")
    .replace(/(https?:\/\/)([^/\s:@]+):([^@\s/]+)@/g, "$1[REDACTED]@")
    .replace(/\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|KEY|PROXY)[A-Z0-9_]*)=([^\s"']+)/gi, "$1=[REDACTED]");
}

function findEvidenceRedactionViolations(value: unknown): string[] {
  const violations: string[] = [];
  const serialized = JSON.stringify(value);
  for (const pattern of [
    /~\/\.agent-pool\/data\/agent-pool\.db/,
    /\.agent-pool\/data\/agent-pool\.db/,
    /\/var\/lib\/agent-pool\/web-sandbox\.db/,
    new RegExp(["AGENT_POOL", "WEB_SANDBOX_DB_PATH"].join("_")),
    /\b(?:ghp|ghs|github_pat)_[A-Za-z0-9_]{20,}/,
    /\be2b_[A-Za-z0-9_-]{20,}/,
    /\bsk-[A-Za-z0-9_-]{20,}/,
    /https?:\/\/[^/\s:@]+:[^@\s/]+@/,
  ]) {
    if (pattern.test(serialized)) violations.push(`forbidden value matched: ${pattern.source}`);
  }
  visit(value, []);
  return violations;

  function visit(current: unknown, path: readonly string[]): void {
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, [...path, String(index)]));
      return;
    }
    const record = readRecord(current);
    if (!record) return;
    for (const [key, child] of Object.entries(record)) {
      if (/^(?:token|serviceToken|bridgeToken|sessionToken|apiKey|githubToken|codexApiKey|e2bApiKey|privateKey|proxyUrl)$/i.test(key)) {
        if (typeof child === "string" && child.trim() && child !== "[REDACTED]" && child !== "[MISSING]" && child !== "<redacted>") {
          violations.push(`secret field must be redacted: ${[...path, key].join(".")}`);
        }
      }
      visit(child, [...path, key]);
    }
  }
}

function buildReadinessChecks(plan: E2BSmokePlan, agentRunnerMode: "bridge-smoke" | "codex"): readonly E2BReadinessCheck[] {
  const missingCredentialSet = new Set(plan.missingCredentials);
  const missingSettingSet = new Set(plan.missingSettings);
  const callbackUrl = plan.launchSpec.bridge.callbackBaseUrl;
  const localCallback = isLocalCallbackUrl(callbackUrl);
  const proxyOnly = plan.securityReadiness.network.proxyOnly;
  const testDirect = plan.securityReadiness.network.egressMode === "test-direct";

  const checks: E2BReadinessCheck[] = [
    {
      id: "e2b-provider-credentials",
      label: "E2B provider credentials",
      status: missingCredentialSet.has("E2B_API_KEY") ? "block" : "pass",
      detail: missingCredentialSet.has("E2B_API_KEY") ? "E2B_API_KEY is missing." : "E2B_API_KEY is configured and redacted.",
      nextAction: missingCredentialSet.has("E2B_API_KEY") ? "Set E2B_API_KEY in .env or the execution environment." : null,
    },
    {
      id: "e2b-template",
      label: "E2B template or image",
      status: missingSettingSet.has("E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID") ? "block" : "pass",
      detail: missingSettingSet.has("E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID")
        ? "No E2B template or sandbox image is configured."
        : "An E2B template or sandbox image is configured.",
      nextAction: missingSettingSet.has("E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID")
        ? "Set E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID after building the Agent Pool template."
        : null,
    },
    {
      id: "e2b-template-compatibility",
      label: "E2B template compatibility",
      status: plan.launchSpec.templateCompatibility.status === "compatible" ? "pass" : "block",
      detail:
        plan.launchSpec.templateCompatibility.status === "compatible"
          ? `Template compatibility digest matches ${AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_DIGEST}.`
          : plan.launchSpec.templateCompatibility.issues[0]?.detail ?? "Template compatibility metadata is missing or incompatible.",
      nextAction:
        plan.launchSpec.templateCompatibility.status === "compatible"
          ? null
          : "Run e2b:template:build -- --dry-run, rebuild the template if needed, and set E2B_TEMPLATE_COMPATIBILITY_DIGEST.",
    },
    {
      id: "callback-url",
      label: "Bridge callback URL",
      status: localCallback ? "block" : /^https:\/\//i.test(callbackUrl) ? "pass" : "warn",
      detail: localCallback
        ? `${callbackUrl} is local-only and not reachable from a live E2B sandbox.`
        : /^https:\/\//i.test(callbackUrl)
          ? "Callback base URL is HTTPS and non-local."
          : "Callback base URL is non-local but not HTTPS.",
      nextAction: localCallback
        ? "Expose the local Caddy/API edge through a tunnel or use the deployed HTTPS API URL."
        : /^https:\/\//i.test(callbackUrl)
          ? null
          : "Use HTTPS for live E2B callback traffic.",
    },
    {
      id: "runtime-source",
      label: "Runtime source",
      status: isValidGithubRepositoryUrl(plan.runtimeSource.repositoryUrl) ? "pass" : "block",
      detail: isValidGithubRepositoryUrl(plan.runtimeSource.repositoryUrl)
        ? "Runtime source uses an HTTPS GitHub repository URL."
        : "Runtime source must be an HTTPS GitHub repository URL.",
      nextAction: isValidGithubRepositoryUrl(plan.runtimeSource.repositoryUrl) ? null : "Set --repository-url to an HTTPS GitHub repository.",
    },
  ];

  if (agentRunnerMode === "codex") {
    checks.push(
      {
        id: "codex-api-key",
        label: "Codex API key",
        status: missingCredentialSet.has("CODEX_API_KEY") ? "block" : "pass",
        detail: missingCredentialSet.has("CODEX_API_KEY") ? "CODEX_API_KEY is missing." : "CODEX_API_KEY is configured and redacted.",
        nextAction: missingCredentialSet.has("CODEX_API_KEY") ? "Set CODEX_API_KEY for Codex non-interactive execution." : null,
      },
      {
        id: "github-app-broker",
        label: "GitHub App broker",
        status:
          missingCredentialSet.has("GITHUB_APP_ID") ||
          missingCredentialSet.has("GITHUB_APP_PRIVATE_KEY") ||
          missingCredentialSet.has("GITHUB_APP_INSTALLATION_ID")
            ? "block"
            : "pass",
        detail:
          missingCredentialSet.has("GITHUB_APP_ID") ||
          missingCredentialSet.has("GITHUB_APP_PRIVATE_KEY") ||
          missingCredentialSet.has("GITHUB_APP_INSTALLATION_ID")
            ? "GitHub App broker credentials are incomplete."
            : "GitHub App broker credentials are configured and redacted.",
        nextAction:
          missingCredentialSet.has("GITHUB_APP_ID") ||
          missingCredentialSet.has("GITHUB_APP_PRIVATE_KEY") ||
          missingCredentialSet.has("GITHUB_APP_INSTALLATION_ID")
            ? "Set GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, and GITHUB_APP_INSTALLATION_ID."
            : null,
      },
      {
        id: "egress-policy",
        label: "Egress policy",
        status: proxyOnly ? "pass" : testDirect ? "warn" : "block",
        detail: proxyOnly
          ? "Codex E2B launch is proxy-only with public traffic disabled."
          : testDirect
            ? "Direct egress is enabled for local/test use."
            : "Codex E2B launch is missing strict proxy egress.",
        nextAction: proxyOnly
          ? null
          : testDirect
            ? "Use proxy-only egress before production live smoke."
            : "Set EGRESS_PROXY_URL and EGRESS_PROXY_ALLOW_OUT or explicitly use E2B_LOCAL_ALLOW_DIRECT_EGRESS=true only for local tests.",
      },
      {
        id: "allowed-egress-domains",
        label: "Allowed egress domains",
        status: plan.runtimeSource.allowedEgressDomains?.length ? "pass" : "block",
        detail: plan.runtimeSource.allowedEgressDomains?.length
          ? `Runtime source declares ${plan.runtimeSource.allowedEgressDomains.length} allowed egress domains.`
          : "Runtime source does not declare allowed egress domains.",
        nextAction: plan.runtimeSource.allowedEgressDomains?.length ? null : "Set AGENT_POOL_ALLOWED_EGRESS_DOMAINS or --allowed-egress-domains.",
      },
      {
        id: "command-profile",
        label: "Command profile",
        status: plan.runtimeSource.commandProfile === "agent-pool-bun-pr" ? "pass" : "block",
        detail:
          plan.runtimeSource.commandProfile === "agent-pool-bun-pr"
            ? "Runtime source uses the initial PR-capable command profile."
            : "Runtime source is missing the supported command profile.",
        nextAction: plan.runtimeSource.commandProfile === "agent-pool-bun-pr" ? null : "Use command profile agent-pool-bun-pr.",
      },
    );
  }

  checks.push({
    id: "default-test-safety",
    label: "Default test safety",
    status: "pass",
    detail: "Default tests remain fake-provider safe; live E2B checks are opt-in.",
    nextAction: null,
  });

  return checks;
}

function nextReadinessAction(status: E2BReadinessStatus): string {
  switch (status) {
    case "ready":
      return "Run opt-in live E2B smoke when you are ready.";
    case "warning":
      return "Resolve readiness warnings before production use; dry-run smoke is still safe.";
    case "blocked":
      return "Resolve blocked readiness checks, then rerun the readiness report.";
  }
}

function buildSecurityReadiness(input: {
  readonly launchSpec: RedactedE2BLaunchSpec;
  readonly cleanup: E2BSmokePlan["cleanup"];
  readonly missingCredentials: readonly string[];
  readonly missingSettings: readonly string[];
}): E2BSmokeSecurityReadiness {
  return {
    execution: {
      defaultTests: "fake-provider-safe",
      liveE2B: "opt-in",
      packageProxySmoke: "opt-in",
    },
    network: {
      egressMode: input.launchSpec.network.egressMode,
      proxyOnly: input.launchSpec.network.egressMode === "proxy" && input.launchSpec.network.allowInternetAccess === false,
      allowInternetAccess: input.launchSpec.network.allowInternetAccess,
      allowPublicTraffic: input.launchSpec.network.allowPublicTraffic,
      allowOut: input.launchSpec.network.allowOut,
      packageProxyMode: readRedactedVariable(input.launchSpec, "AGENT_POOL_PACKAGE_PROXY_MODE"),
      packageProxyUrl: readRedactedVariable(input.launchSpec, "AGENT_POOL_PACKAGE_PROXY_URL"),
    },
    commandPolicy: {
      profile: input.launchSpec.runner.mode === "codex" ? input.launchSpec.runner.codex.commandProfile : null,
      enforcedBy: ["codex rules", "bridge command supervisor", "backend runtime-source validation"],
    },
    credentials: {
      github: "brokered-github-app-installation-token",
      codex: "env-api-key",
      redactedSecretNames: Object.keys(input.launchSpec.environment.secrets).sort(),
      rawSecretsPresent: false,
    },
    snapshotPolicy: {
      successSnapshots: "clean-terminal-sessions-only",
      blockedBy: ["egress-denied", "install-failed", "lockfile-mutated", "scrub-incomplete", "command-denied", "grace-timeout"],
      cleanupAction: input.cleanup.action,
    },
    liveSmokePrerequisites: {
      missingCredentials: input.missingCredentials,
      missingSettings: input.missingSettings,
    },
  };
}

function readRedactedVariable(launchSpec: RedactedE2BLaunchSpec, name: string): string | null {
  const value = launchSpec.environment.variables[name];
  return typeof value === "string" && value.trim() ? value : null;
}

export async function runE2BSmokeCli(args: readonly string[] = process.argv.slice(2), options: E2BSmokeCliOptions = {}): Promise<number> {
  const parsed = parseE2BSmokeArgs(args);
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (parsed.validateEvidencePath) {
    const read = options.readFile ?? readFileText;
    const validation = validateE2BEvidenceBundle(JSON.parse(await read(parsed.validateEvidencePath)));
    write(`${JSON.stringify(validation, null, 2)}\n`);
    return validation.ok ? 0 : 1;
  }

  const env = options.env ?? await loadLocalEnv({ cwd: options.cwd });
  const generatedAt = new Date(options.now?.() ?? Date.now()).toISOString();

  if (parsed.readiness) {
    const plan = createE2BSmokePlan({ ...parsed, env });
    let report = createE2BReadinessReport({ ...parsed, env });
    if (parsed.verifyCallback) {
      const callbackReachability = await verifyCallbackReachability(plan, options.fetch ?? fetch, parsed.callbackTimeoutMs);
      report = withCallbackReachability(report, callbackReachability);
      write(
        `${JSON.stringify(
          parsed.evidence
            ? createE2BEvidenceBundle({ plan, readinessReport: report, status: report.status === "blocked" ? "blocked" : "pass", generatedAt })
            : report,
          null,
          2,
        )}\n`,
      );
      return callbackReachability.ok && report.status !== "blocked" ? 0 : 1;
    }
    write(
      `${JSON.stringify(
        parsed.evidence
          ? createE2BEvidenceBundle({ plan, readinessReport: report, status: report.status === "blocked" ? "blocked" : "pass", generatedAt })
          : report,
        null,
        2,
      )}\n`,
    );
    return 0;
  }

  const plan = createE2BSmokePlan({ ...parsed, env });

  if (parsed.dryRun) {
    write(`${JSON.stringify(parsed.evidence ? createE2BEvidenceBundle({ plan, status: "dry-run", generatedAt }) : plan, null, 2)}\n`);
    return 0;
  }

  if (plan.missingCredentials.length > 0 || plan.missingSettings.length > 0) {
    const error = formatMissingE2BSmokeRequirements(plan);
    write(
      `${JSON.stringify(
        parsed.evidence
          ? createE2BEvidenceBundle({ plan, status: "blocked", generatedAt, error })
          : {
              ok: false,
              error,
              missingCredentials: plan.missingCredentials,
              missingSettings: plan.missingSettings,
            },
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  if (parsed.maliciousFixtures) {
    const error = "live malicious E2B smoke is not enabled yet; run default offline tests or use --dry-run --malicious-fixtures for the fixture plan";
    write(
      `${JSON.stringify(
        parsed.evidence ? createE2BEvidenceBundle({ plan, status: "blocked", generatedAt, error }) : { ok: false, error, maliciousFixtures: plan.maliciousFixtures },
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  const fetchImpl = options.fetch ?? fetch;
  const serviceToken = parsed.serviceToken ?? loadConfig(buildE2BSmokeConfigEnv(env, readAgentRunnerMode(parsed.agentRunnerMode ?? env.AGENT_RUNNER_MODE))).serviceToken.token;

  try {
    if (plan.launchSpec.runner.mode === "codex") {
      const githubApp = await verifyGitHubAppReadiness(plan, serviceToken, fetchImpl);
      if (!isSuccessfulVerification(githubApp)) {
        const diagnostics = {
          failedStage: "readiness",
          detail: "GitHub App installation or repository permissions are not ready for Codex E2B smoke.",
        };
        const error = readVerificationError(githubApp);
        write(
          `${JSON.stringify(
            parsed.evidence
              ? createE2BEvidenceBundle({ plan, status: "blocked", generatedAt, statusResult: githubApp, stageDiagnostics: diagnostics, error })
              : {
                  ok: false,
                  stage: "readiness",
                  error,
                  diagnostics,
                  githubApp,
                },
            null,
            2,
          )}\n`,
        );
        return 1;
      }
    }
    const seed = await seedE2BSmokeFixture(plan, serviceToken, fetchImpl);
    const status = await waitForE2BSmokeCompletion(plan, serviceToken, fetchImpl, options);
    const diagnostics = readSmokeStatusDiagnostics(status);
    write(
      `${JSON.stringify(
        parsed.evidence
          ? createE2BEvidenceBundle({ plan, status: "pass", generatedAt, statusResult: { seed, status }, stageDiagnostics: diagnostics })
          : { ok: true, stage: "complete", seed, status, diagnostics },
        null,
        2,
      )}\n`,
    );
    return 0;
  } catch (error) {
    const stageError = error instanceof E2BSmokeStageError ? error : null;
    const diagnostics = stageError?.diagnostics ?? null;
    write(
      `${JSON.stringify(
        parsed.evidence
          ? createE2BEvidenceBundle({ plan, status: "failed", generatedAt, stageDiagnostics: diagnostics, error: errorMessage(error) })
          : {
              ok: false,
              stage: stageError?.stage ?? "readiness",
              error: errorMessage(error),
              diagnostics,
            },
        null,
        2,
      )}\n`,
    );
    return 1;
  }
}

export function parseE2BSmokeArgs(args: readonly string[]): ParsedE2BSmokeArgs {
  let dryRun = false;
  let readiness = false;
  let apiUrl = DEFAULT_API_URL;
  let serviceToken: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let repositoryUrl = DEFAULT_REPOSITORY_URL;
  let baseRef = DEFAULT_BASE_REF;
  let taskBranchPrefix = DEFAULT_TASK_BRANCH_PREFIX;
  let agentRunnerMode: "bridge-smoke" | "codex" | undefined;
  let allowedEgressDomains: readonly string[] | undefined;
  let maliciousFixtures = false;
  let verifyCallback = false;
  let callbackTimeoutMs = DEFAULT_CALLBACK_REACHABILITY_TIMEOUT_MS;
  let evidence = false;
  let validateEvidencePath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
      case "--plan":
        dryRun = true;
        break;
      case "--readiness":
        readiness = true;
        break;
      case "--api-url":
        apiUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--service-token":
        serviceToken = readFlagValue(args, (index += 1), arg);
        break;
      case "--timeout-ms":
        timeoutMs = readPositiveInteger(readFlagValue(args, (index += 1), arg), arg);
        break;
      case "--repository-url":
        repositoryUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--base-ref":
        baseRef = readFlagValue(args, (index += 1), arg);
        break;
      case "--task-branch-prefix":
        taskBranchPrefix = readFlagValue(args, (index += 1), arg);
        break;
      case "--agent-runner-mode":
        agentRunnerMode = readAgentRunnerMode(readFlagValue(args, (index += 1), arg));
        break;
      case "--allowed-egress-domains":
        allowedEgressDomains = readAllowedEgressDomains(readFlagValue(args, (index += 1), arg));
        break;
      case "--malicious-fixtures":
        maliciousFixtures = true;
        break;
      case "--verify-callback":
        verifyCallback = true;
        break;
      case "--callback-timeout-ms":
        callbackTimeoutMs = readPositiveInteger(readFlagValue(args, (index += 1), arg), arg);
        break;
      case "--evidence":
        evidence = true;
        break;
      case "--validate-evidence":
        validateEvidencePath = readFlagValue(args, (index += 1), arg);
        break;
      default:
        throw new Error(`unknown smoke:e2b argument: ${arg}`);
    }
  }

  return {
    dryRun,
    readiness,
    apiUrl,
    serviceToken,
    timeoutMs,
    repositoryUrl,
    baseRef,
    taskBranchPrefix,
    ...(agentRunnerMode ? { agentRunnerMode } : {}),
    ...(allowedEgressDomains ? { allowedEgressDomains } : {}),
    maliciousFixtures,
    verifyCallback,
    callbackTimeoutMs,
    evidence,
    ...(validateEvidencePath ? { validateEvidencePath } : {}),
  };
}

function isLocalCallbackUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["localhost", "127.0.0.1", "::1", "0.0.0.0"].includes(url.hostname);
  } catch {
    return true;
  }
}

function isValidGithubRepositoryUrl(value: string): boolean {
  return /^https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(value);
}

function readTemplateCompatibilityManifest(env: EnvSource): unknown {
  const raw = env.E2B_TEMPLATE_COMPATIBILITY_MANIFEST_JSON?.trim();
  if (!raw) return undefined;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

async function verifyCallbackReachability(
  plan: E2BSmokePlan,
  fetchImpl: typeof fetch,
  timeoutMs: number,
): Promise<E2BCallbackReachabilityResult> {
  const url = plan.requests.callbackHealth.url;
  const callbackBaseUrl = plan.launchSpec.bridge.callbackBaseUrl;
  if (isLocalCallbackUrl(callbackBaseUrl)) {
    return {
      ok: false,
      status: "local-only",
      url,
      httpStatus: null,
      detail: `${callbackBaseUrl} is local-only and not reachable from a live E2B sandbox.`,
      nextAction: "Expose the local Caddy/API edge through a tunnel or use the deployed HTTPS API URL.",
    };
  }
  if (!/^https:\/\//i.test(callbackBaseUrl)) {
    return {
      ok: false,
      status: "wrong-protocol",
      url,
      httpStatus: null,
      detail: `${callbackBaseUrl} is not HTTPS.`,
      nextAction: "Use an HTTPS Cloudflare tunnel, Caddy edge, or deployed API URL for live E2B callbacks.",
    };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        accept: "application/json",
      },
    });
    await response.text().catch(() => "");
    if (response.ok) {
      return {
        ok: true,
        status: "reachable",
        url,
        httpStatus: response.status,
        detail: `Callback health endpoint is reachable with HTTP ${response.status}.`,
        nextAction: null,
      };
    }
    if (response.status === 401 || response.status === 403) {
      return {
        ok: false,
        status: "auth-failed",
        url,
        httpStatus: response.status,
        detail: `Callback health endpoint returned HTTP ${response.status}; the tunnel or edge may be enforcing auth before the API.`,
        nextAction: "Allow unauthenticated access to /health and /callbacks/* at the public callback edge.",
      };
    }
    if (response.status === 404) {
      return {
        ok: false,
        status: "not-found",
        url,
        httpStatus: response.status,
        detail: "Callback health endpoint returned HTTP 404.",
        nextAction: "Point BRIDGE_CALLBACK_BASE_URL at the Agent Pool API or Caddy edge, not the web-only origin.",
      };
    }
    return {
      ok: false,
      status: "error",
      url,
      httpStatus: response.status,
      detail: `Callback health endpoint returned HTTP ${response.status}.`,
      nextAction: "Check the tunnel, Caddy routing, and API health endpoint.",
    };
  } catch (error) {
    const message = errorMessage(error);
    const timedOut = (error instanceof Error && error.name === "AbortError") || /timeout|timed out|aborted/i.test(message);
    return {
      ok: false,
      status: timedOut ? "timeout" : "error",
      url,
      httpStatus: null,
      detail: timedOut ? `Callback health endpoint timed out after ${timeoutMs}ms.` : `Callback health endpoint failed: ${message}`,
      nextAction: timedOut ? "Check that the tunnel is running and publicly routable." : "Check DNS, TLS, and tunnel routing.",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function seedE2BSmokeFixture(plan: E2BSmokePlan, serviceToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(plan.requests.seed.url, {
    method: "POST",
    headers: {
      [plan.serviceTokenHeaderName]: serviceToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(plan.requests.seed.body),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new E2BSmokeStageError("seed", `e2b smoke seed failed with HTTP ${response.status}`, readSmokeStatusDiagnostics(body));
  }
  return body;
}

async function verifyGitHubAppReadiness(plan: E2BSmokePlan, serviceToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(plan.requests.githubAppVerify.url, {
    method: "POST",
    headers: {
      [plan.serviceTokenHeaderName]: serviceToken,
      "content-type": "application/json",
    },
    body: JSON.stringify(plan.requests.githubAppVerify.body),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      ...(readRecord(body) ?? { error: `github app verification failed with HTTP ${response.status}` }),
    };
  }
  return body;
}

async function waitForE2BSmokeCompletion(
  plan: E2BSmokePlan,
  serviceToken: string,
  fetchImpl: typeof fetch,
  options: Pick<E2BSmokeCliOptions, "sleep" | "now">,
): Promise<unknown> {
  const startedAt = options.now?.() ?? Date.now();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while ((options.now?.() ?? Date.now()) - startedAt <= plan.timeoutMs) {
    const response = await fetchImpl(plan.requests.status.url, {
      headers: {
        [plan.serviceTokenHeaderName]: serviceToken,
      },
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) {
      throw new E2BSmokeStageError("claim", `e2b smoke status failed with HTTP ${response.status}`, readSmokeStatusDiagnostics(body));
    }
    if (isCompleteSmokeStatus(body)) return body;
    if (isFailedSmokeStatus(body)) {
      const stage = readSmokeStatusStage(body) ?? "codex";
      throw new E2BSmokeStageError(stage, `e2b smoke task failed during ${stage}`, readSmokeStatusDiagnostics(body));
    }
    await sleep(250);
  }

  throw new E2BSmokeStageError("claim", `e2b smoke timed out after ${plan.timeoutMs}ms`);
}

function isCompleteSmokeStatus(body: unknown): boolean {
  const record = readRecord(body);
  const baseComplete = Boolean(
    readRecord(record?.finalResponse)?.recorded &&
      readRecord(record?.completion)?.completed &&
      readRecord(record?.cleanup)?.completed,
  );
  if (!baseComplete) return false;
  const diagnostics = readRecord(record?.diagnostics);
  if (!diagnostics) return true;
  if (readSmokeStatusStage(record)) return false;
  const stages = Array.isArray(diagnostics.stages) ? diagnostics.stages : [];
  const snapshot = stages.map(readRecord).find((stage) => stage?.id === "snapshot");
  return !snapshot || snapshot.status === "passed";
}

function isFailedSmokeStatus(body: unknown): boolean {
  return Boolean(readRecord(readRecord(body)?.failure)?.failed || readSmokeStatusStage(body));
}

function readSmokeStatusDiagnostics(body: unknown): unknown {
  return readRecord(readRecord(body)?.diagnostics) ?? null;
}

function readSmokeStatusStage(body: unknown): E2BSmokeDiagnosticStage | null {
  const diagnostics = readRecord(readRecord(body)?.diagnostics);
  if (!diagnostics) return null;
  const failedStage = readDiagnosticStage(diagnostics.failedStage);
  if (failedStage) return failedStage;
  const stages = Array.isArray(diagnostics.stages) ? diagnostics.stages : [];
  const failed = stages
    .map(readRecord)
    .find((stage) => stage && (stage.status === "failed" || stage.status === "risk"));
  return readDiagnosticStage(failed?.id);
}

function readDiagnosticStage(value: unknown): E2BSmokeDiagnosticStage | null {
  if (typeof value !== "string") return null;
  return isE2BSmokeDiagnosticStage(value) ? value : null;
}

function isE2BSmokeDiagnosticStage(value: string): value is E2BSmokeDiagnosticStage {
  return [
    "readiness",
    "seed",
    "claim",
    "sandbox-create",
    "bootstrap-clone",
    "install",
    "codex",
    "pr",
    "cleanup",
    "snapshot",
  ].includes(value);
}

function isSuccessfulVerification(body: unknown): boolean {
  return readRecord(body)?.ok === true;
}

function readVerificationError(body: unknown): string {
  const record = readRecord(body);
  const error = record?.error;
  return typeof error === "string" && error.trim() ? error.trim() : "github_app_verification_failed";
}

function formatMissingE2BSmokeRequirements(plan: E2BSmokePlan): string {
  const missing = [...plan.missingCredentials, ...plan.missingSettings];
  return `missing required E2B smoke settings: ${missing.join(", ")}`;
}

function readMissingCredentials(
  env: EnvSource,
  e2b: ReturnType<typeof loadConfig>["controlPlane"]["e2b"],
  agentRunnerMode: "bridge-smoke" | "codex",
): readonly string[] {
  const required =
    agentRunnerMode === "codex"
      ? [
          e2b.apiKeyEnvName,
          e2b.codexApiKeyEnvName,
          "GITHUB_APP_ID",
          "GITHUB_APP_PRIVATE_KEY",
          "GITHUB_APP_INSTALLATION_ID",
        ]
      : [e2b.apiKeyEnvName, e2b.githubTokenEnvName];
  return required.filter((name) => !env[name]?.trim());
}

function readMissingSettings(
  e2b: ReturnType<typeof loadConfig>["controlPlane"]["e2b"],
  agentRunnerMode: "bridge-smoke" | "codex",
  allowedEgressDomains: readonly string[],
): readonly string[] {
  const missing = [...(e2b.templateId || e2b.sandboxImageId ? [] : ["E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID"])];
  if (agentRunnerMode === "codex") {
    if (!e2b.localAllowDirectEgress && (!e2b.egressProxyUrl || e2b.egressProxyAllowOut.length === 0)) {
      missing.push("EGRESS_PROXY_URL and EGRESS_PROXY_ALLOW_OUT or E2B_LOCAL_ALLOW_DIRECT_EGRESS=true");
    }
    if (allowedEgressDomains.length === 0) {
      missing.push("AGENT_POOL_ALLOWED_EGRESS_DOMAINS");
    }
  }
  return missing;
}

function buildE2BSmokeConfigEnv(env: EnvSource, agentRunnerMode: "bridge-smoke" | "codex"): EnvSource {
  return {
    ...env,
    AUTH_MODE: env.AUTH_MODE ?? "test",
    INTERNAL_SERVICE_TOKEN: env.INTERNAL_SERVICE_TOKEN ?? DEFAULT_COMPOSE_SERVICE_TOKEN,
    AGENT_RUNNER_MODE: agentRunnerMode,
    RUNTIME_PROVIDER: "fake",
  };
}

function readAgentRunnerMode(value: string | undefined): "bridge-smoke" | "codex" {
  const mode = value?.trim() || "bridge-smoke";
  if (mode === "bridge-smoke" || mode === "codex") return mode;
  throw new Error("agent runner mode must be bridge-smoke or codex");
}

function readAllowedEgressDomains(value: string | undefined): readonly string[] {
  const raw = value?.trim();
  if (!raw) return DEFAULT_ALLOWED_EGRESS_DOMAINS;
  return [
    ...new Set(
      raw
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInteger(value: string, name: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
  return number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function readRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Readonly<Record<string, unknown>>) : null;
}

async function readFileText(path: string): Promise<string> {
  return readFile(path, "utf8");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const code = await runE2BSmokeCli();
  process.exit(code);
}
