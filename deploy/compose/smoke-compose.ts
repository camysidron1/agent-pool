import { resolve } from "node:path";

import { loadLocalEnv, readProcessEnv, type EnvSource } from "../local-env";

export type ComposeSmokeCommand = {
  readonly label: string;
  readonly command: readonly string[];
};

export type ComposeSmokeEndpoint = {
  readonly label: string;
  readonly url: string;
};

export type ComposeSmokePlan = {
  readonly composeFile: string;
  readonly projectName: string;
  readonly apiUrl: string;
  readonly orchestratorUrl: string;
  readonly edgeUrl: string;
  readonly prometheusUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly teardown: boolean;
  readonly bootOnly: boolean;
  readonly commands: readonly ComposeSmokeCommand[];
  readonly readiness: readonly ComposeSmokeEndpoint[];
};

export type ComposeSmokeCliOptions = {
  readonly cwd?: string;
  readonly env?: EnvSource;
  readonly write?: (text: string) => void;
  readonly runCommand?: (command: readonly string[], options: ComposeSmokeCommandOptions) => Promise<void>;
  readonly runCommandOutput?: (command: readonly string[], options: ComposeSmokeCommandOptions) => Promise<string>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

export type ComposeSmokeCommandOptions = {
  readonly cwd: string;
  readonly env?: EnvSource;
};

type ParsedComposeSmokeArgs = {
  readonly dryRun: boolean;
  readonly composeFile?: string;
  readonly projectName: string;
  readonly apiUrl: string;
  readonly orchestratorUrl: string;
  readonly edgeUrl: string;
  readonly prometheusUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly teardown: boolean;
  readonly bootOnly: boolean;
};

const DEFAULT_PROJECT_NAME = "agent-pool-compose-smoke";
const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:3001";
const DEFAULT_EDGE_URL = "http://127.0.0.1:3080";
const DEFAULT_PROMETHEUS_URL = "http://127.0.0.1:9090";
const DEFAULT_SERVICE_TOKEN = "compose-internal-service-token";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createComposeSmokePlan(input: Partial<ParsedComposeSmokeArgs> & { readonly cwd?: string } = {}): ComposeSmokePlan {
  const cwd = input.cwd ?? process.cwd();
  const composeFile = resolve(cwd, input.composeFile ?? "deploy/compose/docker-compose.yml");
  const projectName = input.projectName ?? DEFAULT_PROJECT_NAME;
  const apiUrl = trimTrailingSlash(input.apiUrl ?? DEFAULT_API_URL);
  const orchestratorUrl = trimTrailingSlash(input.orchestratorUrl ?? DEFAULT_ORCHESTRATOR_URL);
  const edgeUrl = trimTrailingSlash(input.edgeUrl ?? DEFAULT_EDGE_URL);
  const prometheusUrl = trimTrailingSlash(input.prometheusUrl ?? DEFAULT_PROMETHEUS_URL);
  const serviceToken = input.serviceToken ?? DEFAULT_SERVICE_TOKEN;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const teardown = input.teardown ?? true;
  const bootOnly = input.bootOnly ?? false;

  return {
    composeFile,
    projectName,
    apiUrl,
    orchestratorUrl,
    edgeUrl,
    prometheusUrl,
    serviceToken,
    timeoutMs,
    teardown,
    bootOnly,
    commands: [
      {
        label: "boot compose stack",
        command: ["docker", "compose", "-f", composeFile, "-p", projectName, "up", "-d", "--wait"],
      },
      {
        label: "tear down compose stack",
        command: ["docker", "compose", "-f", composeFile, "-p", projectName, "down", "--timeout", "15", "-v", "--remove-orphans"],
      },
      {
        label: "collect compose logs",
        command: ["docker", "compose", "-f", composeFile, "-p", projectName, "logs", "--no-color", "--tail", "200"],
      },
    ],
    readiness: [
      { label: "api health", url: `${apiUrl}/health` },
      { label: "orchestrator health", url: `${orchestratorUrl}/health` },
      { label: "egress gateway health", url: "http://127.0.0.1:3002/health" },
      { label: "caddy edge health", url: `${edgeUrl}/healthz` },
      { label: "api through caddy", url: `${edgeUrl}/health` },
      { label: "web through caddy", url: `${edgeUrl}/` },
      { label: "rabbitmq management", url: "http://127.0.0.1:15672/api/overview" },
      { label: "minio readiness", url: "http://127.0.0.1:9000/minio/health/ready" },
      { label: "prometheus health", url: `${prometheusUrl}/-/healthy` },
    ],
  };
}

export async function runComposeSmokeCli(args: readonly string[] = process.argv.slice(2), options: ComposeSmokeCliOptions = {}): Promise<number> {
  const parsed = parseComposeSmokeArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const plan = createComposeSmokePlan({ ...parsed, cwd });
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const commandEnv = options.env ?? await loadLocalEnv({ cwd });

  if (parsed.dryRun) {
    write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  const runCommand = options.runCommand ?? runSubprocess;
  const runCommandOutput = options.runCommandOutput ?? runSubprocessOutput;
  const fetchImpl = options.fetch ?? fetch;
  let exitCode = 0;
  let failure: unknown = null;

  try {
    await runCommand(plan.commands[0].command, { cwd, env: commandEnv });
    await waitForReadiness(plan, fetchImpl, options);
    if (plan.bootOnly) {
      write(`${JSON.stringify({ ok: true, booted: true, edgeUrl: plan.edgeUrl, apiUrl: plan.apiUrl, orchestratorUrl: plan.orchestratorUrl }, null, 2)}\n`);
      return 0;
    }
    await seedSmokeFixture(plan, fetchImpl);
    const status = await waitForSmokeCompletion(plan, fetchImpl, options);
    const prometheus = await waitForPrometheusVerification(plan, fetchImpl, options);
    write(`${JSON.stringify({ ok: true, status, prometheus }, null, 2)}\n`);
  } catch (error) {
    exitCode = 1;
    failure = error;
    const diagnostics = await collectFailureDiagnostics(plan, fetchImpl, runCommandOutput, cwd, commandEnv);
    write(`${JSON.stringify({ ok: false, error: errorMessage(error), diagnostics }, null, 2)}\n`);
  } finally {
    if (plan.teardown) {
      try {
        await runCommand(plan.commands[1].command, { cwd, env: commandEnv });
      } catch (error) {
        if (failure) {
          write(`${JSON.stringify({ ok: false, teardownError: errorMessage(error) }, null, 2)}\n`);
        } else {
          exitCode = 1;
          write(`${JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2)}\n`);
        }
      }
    }
  }

  return exitCode;
}

export function parseComposeSmokeArgs(args: readonly string[]): ParsedComposeSmokeArgs {
  let dryRun = false;
  let composeFile: string | undefined;
  let projectName = DEFAULT_PROJECT_NAME;
  let apiUrl = DEFAULT_API_URL;
  let orchestratorUrl = DEFAULT_ORCHESTRATOR_URL;
  let edgeUrl = DEFAULT_EDGE_URL;
  let prometheusUrl = DEFAULT_PROMETHEUS_URL;
  let serviceToken = DEFAULT_SERVICE_TOKEN;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let teardown = true;
  let bootOnly = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--dry-run":
      case "--plan":
        dryRun = true;
        break;
      case "--compose-file":
        composeFile = readFlagValue(args, (index += 1), arg);
        break;
      case "--project-name":
        projectName = readFlagValue(args, (index += 1), arg);
        break;
      case "--api-url":
        apiUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--orchestrator-url":
        orchestratorUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--edge-url":
        edgeUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--prometheus-url":
        prometheusUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--service-token":
        serviceToken = readFlagValue(args, (index += 1), arg);
        break;
      case "--timeout-ms":
        timeoutMs = readPositiveInteger(readFlagValue(args, (index += 1), arg), arg);
        break;
      case "--no-teardown":
        teardown = false;
        break;
      case "--boot-only":
        bootOnly = true;
        teardown = false;
        break;
      default:
        throw new Error(`unknown smoke:compose argument: ${arg}`);
    }
  }

  return {
    dryRun,
    composeFile,
    projectName,
    apiUrl,
    orchestratorUrl,
    edgeUrl,
    prometheusUrl,
    serviceToken,
    timeoutMs,
    teardown,
    bootOnly,
  };
}

export type PrometheusVerification = {
  readonly targets: {
    readonly api: boolean;
    readonly orchestrator: boolean;
  };
  readonly metrics: {
    readonly apiOutboxPublished: number;
    readonly orchestratorTaskConsumerRuns: number;
    readonly orchestratorTaskClaims: number;
  };
};

export async function readPrometheusVerification(
  plan: Pick<ComposeSmokePlan, "prometheusUrl">,
  fetchImpl: typeof fetch,
): Promise<PrometheusVerification> {
  const [targets, apiOutboxPublished, orchestratorTaskConsumerRuns, orchestratorTaskClaims] = await Promise.all([
    fetchPrometheusTargets(`${plan.prometheusUrl}/api/v1/targets?state=active`, fetchImpl),
    fetchPrometheusScalar(`${plan.prometheusUrl}/api/v1/query?query=${encodeURIComponent("agent_pool_api_outbox_published")}`, fetchImpl),
    fetchPrometheusScalar(
      `${plan.prometheusUrl}/api/v1/query?query=${encodeURIComponent("agent_pool_orchestrator_task_consumer_runs_total")}`,
      fetchImpl,
    ),
    fetchPrometheusScalar(
      `${plan.prometheusUrl}/api/v1/query?query=${encodeURIComponent("agent_pool_orchestrator_task_claim_total")}`,
      fetchImpl,
    ),
  ]);

  return {
    targets,
    metrics: {
      apiOutboxPublished,
      orchestratorTaskConsumerRuns,
      orchestratorTaskClaims,
    },
  };
}

export function isPrometheusVerificationComplete(verification: PrometheusVerification): boolean {
  return verification.targets.api &&
    verification.targets.orchestrator &&
    verification.metrics.apiOutboxPublished > 0 &&
    verification.metrics.orchestratorTaskConsumerRuns > 0 &&
    verification.metrics.orchestratorTaskClaims > 0;
}

async function waitForReadiness(
  plan: ComposeSmokePlan,
  fetchImpl: typeof fetch,
  options: Pick<ComposeSmokeCliOptions, "sleep" | "now">,
): Promise<void> {
  for (const endpoint of plan.readiness) {
    await waitForEndpoint(endpoint, plan.timeoutMs, fetchImpl, options);
  }
}

async function waitForEndpoint(
  endpoint: ComposeSmokeEndpoint,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  options: Pick<ComposeSmokeCliOptions, "sleep" | "now">,
): Promise<void> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  let lastError = "not checked";

  while (now() - started <= timeoutMs) {
    try {
      const response = await fetchImpl(endpoint.url, {
        headers: endpoint.label === "rabbitmq management" ? { authorization: `Basic ${btoa("guest:guest")}` } : undefined,
      });
      if (response.ok) return;
      lastError = `status ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1000);
  }

  throw new Error(`timed out waiting for ${endpoint.label} at ${endpoint.url}: ${lastError}`);
}

async function seedSmokeFixture(plan: ComposeSmokePlan, fetchImpl: typeof fetch): Promise<void> {
  const response = await fetchImpl(`${plan.apiUrl}/internal/smoke/seed`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-agent-pool-service-token": plan.serviceToken,
    },
  });

  if (!response.ok) {
    throw new Error(`smoke seed failed with status ${response.status}: ${await response.text().catch(() => "")}`);
  }
}

async function waitForSmokeCompletion(
  plan: ComposeSmokePlan,
  fetchImpl: typeof fetch,
  options: Pick<ComposeSmokeCliOptions, "sleep" | "now">,
): Promise<unknown> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  let lastStatus: unknown = null;

  while (now() - started <= plan.timeoutMs) {
    const response = await fetchImpl(`${plan.apiUrl}/internal/smoke/status`, {
      headers: {
        "x-agent-pool-service-token": plan.serviceToken,
      },
    });

    if (response.ok) {
      const body = await response.json();
      lastStatus = body;
      if (isSmokeComplete(body)) return body;
    } else {
      lastStatus = { status: response.status, body: await response.text().catch(() => "") };
    }

    await sleep(1000);
  }

  throw new Error(`timed out waiting for smoke completion: ${JSON.stringify(lastStatus)}`);
}

async function waitForPrometheusVerification(
  plan: ComposeSmokePlan,
  fetchImpl: typeof fetch,
  options: Pick<ComposeSmokeCliOptions, "sleep" | "now">,
): Promise<PrometheusVerification> {
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const started = now();
  let lastVerification: PrometheusVerification | null = null;
  let lastError = "not checked";

  while (now() - started <= plan.timeoutMs) {
    try {
      lastVerification = await readPrometheusVerification(plan, fetchImpl);
      if (isPrometheusVerificationComplete(lastVerification)) return lastVerification;
      lastError = JSON.stringify(lastVerification);
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }

    await sleep(1000);
  }

  throw new Error(`timed out waiting for Prometheus verification: ${lastError}`);
}

export type SmokeFailureDiagnostics = {
  readonly statusSnapshot: unknown;
  readonly logs: string;
  readonly logCommand: readonly string[];
};

export async function collectFailureDiagnostics(
  plan: ComposeSmokePlan,
  fetchImpl: typeof fetch,
  runCommandOutput: (command: readonly string[], options: ComposeSmokeCommandOptions) => Promise<string>,
  cwd: string,
  env?: EnvSource,
): Promise<SmokeFailureDiagnostics> {
  const statusSnapshot = await fetchSmokeStatusSnapshot(plan, fetchImpl);
  const logCommand = plan.commands.find((command) => command.label === "collect compose logs")?.command ?? [];
  const logs = logCommand.length > 0
    ? await runCommandOutput(logCommand, { cwd, env }).catch((error) => `failed to collect compose logs: ${errorMessage(error)}`)
    : "compose log command unavailable";

  return {
    statusSnapshot,
    logs,
    logCommand,
  };
}

async function fetchSmokeStatusSnapshot(plan: ComposeSmokePlan, fetchImpl: typeof fetch): Promise<unknown> {
  try {
    const response = await fetchImpl(`${plan.apiUrl}/internal/smoke/status`, {
      headers: {
        "x-agent-pool-service-token": plan.serviceToken,
      },
    });
    const text = await response.text();

    return {
      ok: response.ok,
      status: response.status,
      body: parseJsonOrText(text),
    };
  } catch (error) {
    return {
      ok: false,
      error: errorMessage(error),
    };
  }
}

async function fetchPrometheusTargets(url: string, fetchImpl: typeof fetch): Promise<PrometheusVerification["targets"]> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Prometheus targets request failed with status ${response.status}`);
  }

  const body = await response.json();
  const targets = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.activeTargets)
    ? body.data.activeTargets
    : [];

  return {
    api: targets.some((target) => isHealthyTarget(target, "agent-pool-api")),
    orchestrator: targets.some((target) => isHealthyTarget(target, "agent-pool-orchestrator")),
  };
}

async function fetchPrometheusScalar(url: string, fetchImpl: typeof fetch): Promise<number> {
  const response = await fetchImpl(url);
  if (!response.ok) {
    throw new Error(`Prometheus query failed with status ${response.status}`);
  }

  const body = await response.json();
  const result = isRecord(body) && isRecord(body.data) && Array.isArray(body.data.result) ? body.data.result : [];
  const value = result.find(isPrometheusVectorResult)?.value[1];
  const number = Number(value);

  return Number.isFinite(number) ? number : 0;
}

function isSmokeComplete(body: unknown): boolean {
  if (!body || typeof body !== "object") return false;
  const candidate = body as {
    readonly ok?: unknown;
    readonly finalResponse?: { readonly recorded?: unknown };
    readonly completion?: { readonly completed?: unknown };
    readonly cleanup?: { readonly completed?: unknown };
  };

  return candidate.ok === true &&
    candidate.finalResponse?.recorded === true &&
    candidate.completion?.completed === true &&
    candidate.cleanup?.completed === true;
}

function isHealthyTarget(value: unknown, job: string): boolean {
  if (!isRecord(value)) return false;
  const labels = isRecord(value.labels) ? value.labels : isRecord(value.discoveredLabels) ? value.discoveredLabels : {};

  return value.health === "up" && labels.job === job;
}

function isPrometheusVectorResult(value: unknown): value is { readonly value: readonly [number, string] } {
  return isRecord(value) &&
    Array.isArray(value.value) &&
    value.value.length >= 2 &&
    typeof value.value[1] === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

async function runSubprocess(command: readonly string[], options: ComposeSmokeCommandOptions): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: buildSubprocessEnv(options.env),
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await process.exited;

  if (status !== 0) {
    throw new Error(`command failed (${status}): ${command.join(" ")}`);
  }
}

async function runSubprocessOutput(command: readonly string[], options: ComposeSmokeCommandOptions): Promise<string> {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    env: buildSubprocessEnv(options.env),
    stdout: "pipe",
    stderr: "pipe",
  });
  const [status, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);
  const output = [stdout, stderr].filter(Boolean).join("\n");

  if (status !== 0) {
    throw new Error(`command failed (${status}): ${command.join(" ")}${output ? `\n${output}` : ""}`);
  }

  return output;
}

function readFlagValue(args: readonly string[], index: number, flag: string): string {
  const value = args[index];
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInteger(value: string, flag: string): number {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) {
    throw new Error(`${flag} requires a positive integer`);
  }
  return number;
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildSubprocessEnv(env: EnvSource | undefined): Record<string, string> | undefined {
  if (!env) return undefined;
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(readProcessEnv())) {
    if (value !== undefined) merged[key] = value;
  }

  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

function parseJsonOrText(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

if (import.meta.main) {
  runComposeSmokeCli().then(
    (code) => {
      process.exit(code);
    },
    (error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    },
  );
}
