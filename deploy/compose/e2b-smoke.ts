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
};

export type E2BReadinessStatus = "ready" | "blocked" | "warning";

export type E2BReadinessCheck = {
  readonly id: string;
  readonly label: string;
  readonly status: "pass" | "block" | "warn";
  readonly detail: string;
  readonly nextAction: string | null;
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
  const hasBlocks = checks.some((check) => check.status === "block");
  const hasWarnings = checks.some((check) => check.status === "warn");
  const status: E2BReadinessStatus = hasBlocks ? "blocked" : hasWarnings ? "warning" : "ready";

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
  const env = options.env ?? await loadLocalEnv({ cwd: options.cwd });
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (parsed.readiness) {
    const report = createE2BReadinessReport({ ...parsed, env });
    write(`${JSON.stringify(report, null, 2)}\n`);
    return 0;
  }

  const plan = createE2BSmokePlan({ ...parsed, env });

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
