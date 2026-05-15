import { loadConfig, type EnvSource } from "@agent-pool/config";
import {
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
    readonly seed: E2BSmokeRequest;
    readonly status: E2BSmokeRequest;
  };
};

export type E2BSmokeCliOptions = {
  readonly cwd?: string;
  readonly env?: EnvSource;
  readonly write?: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

type ParsedE2BSmokeArgs = {
  readonly dryRun: boolean;
  readonly apiUrl: string;
  readonly serviceToken?: string;
  readonly timeoutMs: number;
  readonly repositoryUrl: string;
  readonly baseRef: string;
  readonly taskBranchPrefix: string;
  readonly agentRunnerMode?: "bridge-smoke" | "codex";
  readonly allowedEgressDomains?: readonly string[];
  readonly maliciousFixtures: boolean;
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

  return {
    runtimeProvider: "e2b",
    apiUrl,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    serviceTokenHeaderName: config.serviceToken.headerName,
    serviceToken: serviceToken.trim() ? "[REDACTED]" : "[MISSING]",
    missingCredentials,
    missingSettings,
    runtimeSource,
    launchSpec: redactE2BLaunchSpec(launchSpec),
    bootstrap,
    bridgeStartup: bridgeStartup.redactedEnv,
    cleanup: {
      provider: "e2b",
      sandboxId: "<runtime-session-id>",
      timeoutMs: e2b.cleanupTimeoutMs,
      action: "destroy sandbox through RuntimeProvider.stopSession",
    },
    maliciousFixtures: {
      enabled: input.maliciousFixtures === true,
      liveExecution:
        input.maliciousFixtures === true
          ? input.dryRun === true
            ? "dry_run_only"
            : "skipped_until_live_runner_is_ready"
          : "not_requested",
      fixtureIds: input.maliciousFixtures === true ? MALICIOUS_FIXTURE_IDS : [],
    },
    requests: {
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

export async function runE2BSmokeCli(args: readonly string[] = process.argv.slice(2), options: E2BSmokeCliOptions = {}): Promise<number> {
  const parsed = parseE2BSmokeArgs(args);
  const env = options.env ?? await loadLocalEnv({ cwd: options.cwd });
  const plan = createE2BSmokePlan({ ...parsed, env });
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (parsed.dryRun) {
    write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  if (plan.missingCredentials.length > 0 || plan.missingSettings.length > 0) {
    write(
      `${JSON.stringify(
        {
          ok: false,
          error: formatMissingE2BSmokeRequirements(plan),
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
    write(
      `${JSON.stringify(
        {
          ok: false,
          error: "live malicious E2B smoke is not enabled yet; run default offline tests or use --dry-run --malicious-fixtures for the fixture plan",
          maliciousFixtures: plan.maliciousFixtures,
        },
        null,
        2,
      )}\n`,
    );
    return 1;
  }

  const fetchImpl = options.fetch ?? fetch;
  const serviceToken = parsed.serviceToken ?? loadConfig(buildE2BSmokeConfigEnv(env, readAgentRunnerMode(parsed.agentRunnerMode ?? env.AGENT_RUNNER_MODE))).serviceToken.token;

  try {
    const seed = await seedE2BSmokeFixture(plan, serviceToken, fetchImpl);
    const status = await waitForE2BSmokeCompletion(plan, serviceToken, fetchImpl, options);
    write(`${JSON.stringify({ ok: true, seed, status }, null, 2)}\n`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2)}\n`);
    return 1;
  }
}

export function parseE2BSmokeArgs(args: readonly string[]): ParsedE2BSmokeArgs {
  let dryRun = false;
  let apiUrl = DEFAULT_API_URL;
  let serviceToken: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let repositoryUrl = DEFAULT_REPOSITORY_URL;
  let baseRef = DEFAULT_BASE_REF;
  let taskBranchPrefix = DEFAULT_TASK_BRANCH_PREFIX;
  let agentRunnerMode: "bridge-smoke" | "codex" | undefined;
  let allowedEgressDomains: readonly string[] | undefined;
  let maliciousFixtures = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
      case "--plan":
        dryRun = true;
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
      default:
        throw new Error(`unknown smoke:e2b argument: ${arg}`);
    }
  }

  return {
    dryRun,
    apiUrl,
    serviceToken,
    timeoutMs,
    repositoryUrl,
    baseRef,
    taskBranchPrefix,
    ...(agentRunnerMode ? { agentRunnerMode } : {}),
    ...(allowedEgressDomains ? { allowedEgressDomains } : {}),
    maliciousFixtures,
  };
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
    throw new Error(`e2b smoke seed failed with HTTP ${response.status}`);
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
      throw new Error(`e2b smoke status failed with HTTP ${response.status}`);
    }
    if (isCompleteSmokeStatus(body)) return body;
    if (isFailedSmokeStatus(body)) {
      throw new Error("e2b smoke task failed before completion");
    }
    await sleep(250);
  }

  throw new Error(`e2b smoke timed out after ${plan.timeoutMs}ms`);
}

function isCompleteSmokeStatus(body: unknown): boolean {
  const record = readRecord(body);
  return Boolean(
    readRecord(record?.finalResponse)?.recorded &&
      readRecord(record?.completion)?.completed &&
      readRecord(record?.cleanup)?.completed,
  );
}

function isFailedSmokeStatus(body: unknown): boolean {
  return Boolean(readRecord(readRecord(body)?.failure)?.failed);
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  const code = await runE2BSmokeCli();
  process.exit(code);
}
