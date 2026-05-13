import { isPrometheusVerificationComplete, readPrometheusVerification, type PrometheusVerification } from "../compose/smoke-compose";

export type KubernetesSmokeEndpoint = {
  readonly label: string;
  readonly url: string;
};

export type KubernetesSmokeRequest = {
  readonly method: "GET" | "POST";
  readonly url: string;
};

export type KubernetesSmokePlan = {
  readonly apiUrl: string;
  readonly orchestratorUrl: string;
  readonly prometheusUrl: string;
  readonly timeoutMs: number;
  readonly serviceTokenHeaderName: string;
  readonly serviceToken: "[REDACTED]" | "[MISSING]";
  readonly readiness: readonly KubernetesSmokeEndpoint[];
  readonly requests: {
    readonly seed: KubernetesSmokeRequest;
    readonly status: KubernetesSmokeRequest;
  };
  readonly e2bSmokeCommand: readonly string[];
};

export type KubernetesSmokeCliOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly write?: (text: string) => void;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

type ParsedKubernetesSmokeArgs = {
  readonly dryRun: boolean;
  readonly apiUrl: string;
  readonly orchestratorUrl: string;
  readonly prometheusUrl: string;
  readonly serviceToken?: string;
  readonly serviceTokenHeaderName: string;
  readonly timeoutMs: number;
};

const DEFAULT_API_URL = "https://agent-pool.example.com";
const DEFAULT_ORCHESTRATOR_URL = "http://agent-pool-orchestrator.agent-pool.svc.cluster.local:3001";
const DEFAULT_PROMETHEUS_URL = "http://agent-pool-prometheus.agent-pool.svc.cluster.local:9090";
const DEFAULT_SERVICE_TOKEN_HEADER = "x-agent-pool-service-token";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createKubernetesSmokePlan(input: Partial<ParsedKubernetesSmokeArgs> = {}): KubernetesSmokePlan {
  const apiUrl = trimTrailingSlash(input.apiUrl ?? DEFAULT_API_URL);
  const orchestratorUrl = trimTrailingSlash(input.orchestratorUrl ?? DEFAULT_ORCHESTRATOR_URL);
  const prometheusUrl = trimTrailingSlash(input.prometheusUrl ?? DEFAULT_PROMETHEUS_URL);
  const serviceToken = input.serviceToken?.trim();

  return {
    apiUrl,
    orchestratorUrl,
    prometheusUrl,
    timeoutMs: input.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    serviceTokenHeaderName: input.serviceTokenHeaderName ?? DEFAULT_SERVICE_TOKEN_HEADER,
    serviceToken: serviceToken ? "[REDACTED]" : "[MISSING]",
    readiness: [
      { label: "api health", url: `${apiUrl}/health` },
      { label: "orchestrator health", url: `${orchestratorUrl}/health` },
      { label: "prometheus health", url: `${prometheusUrl}/-/healthy` },
    ],
    requests: {
      seed: { method: "POST", url: `${apiUrl}/internal/smoke/seed` },
      status: { method: "GET", url: `${apiUrl}/internal/smoke/status` },
    },
    e2bSmokeCommand: [
      "bun",
      "run",
      "smoke:e2b",
      "--api-url",
      apiUrl,
      "--service-token",
      "<redacted-service-token>",
      "--repository-url",
      "https://github.com/example/tiny-fixture.git",
    ],
  };
}

export async function runKubernetesSmokeCli(
  args: readonly string[] = process.argv.slice(2),
  options: KubernetesSmokeCliOptions = {},
): Promise<number> {
  const parsed = parseKubernetesSmokeArgs(args);
  const env = options.env ?? readProcessEnv();
  const serviceToken = parsed.serviceToken?.trim() || env.INTERNAL_SERVICE_TOKEN?.trim() || "";
  const plan = createKubernetesSmokePlan({ ...parsed, serviceToken });
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (parsed.dryRun) {
    write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  if (!serviceToken) {
    write(`${JSON.stringify({ ok: false, error: "INTERNAL_SERVICE_TOKEN or --service-token is required for deployed smoke" }, null, 2)}\n`);
    return 1;
  }

  const fetchImpl = options.fetch ?? fetch;

  try {
    await waitForReadiness(plan, fetchImpl, options);
    const seed = await seedSmokeFixture(plan, serviceToken, fetchImpl);
    const status = await waitForSmokeCompletion(plan, serviceToken, fetchImpl, options);
    const prometheus = await waitForPrometheusVerification(plan, fetchImpl, options);
    write(`${JSON.stringify({ ok: true, seed, status, prometheus }, null, 2)}\n`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2)}\n`);
    return 1;
  }
}

export function parseKubernetesSmokeArgs(args: readonly string[]): ParsedKubernetesSmokeArgs {
  let dryRun = false;
  let apiUrl = DEFAULT_API_URL;
  let orchestratorUrl = DEFAULT_ORCHESTRATOR_URL;
  let prometheusUrl = DEFAULT_PROMETHEUS_URL;
  let serviceToken: string | undefined;
  let serviceTokenHeaderName = DEFAULT_SERVICE_TOKEN_HEADER;
  let timeoutMs = DEFAULT_TIMEOUT_MS;

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
      case "--orchestrator-url":
        orchestratorUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--prometheus-url":
        prometheusUrl = readFlagValue(args, (index += 1), arg);
        break;
      case "--service-token":
        serviceToken = readFlagValue(args, (index += 1), arg);
        break;
      case "--service-token-header":
        serviceTokenHeaderName = readFlagValue(args, (index += 1), arg).toLowerCase();
        break;
      case "--timeout-ms":
        timeoutMs = readPositiveInteger(readFlagValue(args, (index += 1), arg), arg);
        break;
      default:
        throw new Error(`unknown smoke:kubernetes argument: ${arg}`);
    }
  }

  return {
    dryRun,
    apiUrl,
    orchestratorUrl,
    prometheusUrl,
    serviceToken,
    serviceTokenHeaderName,
    timeoutMs,
  };
}

async function waitForReadiness(
  plan: KubernetesSmokePlan,
  fetchImpl: typeof fetch,
  options: Pick<KubernetesSmokeCliOptions, "sleep" | "now">,
): Promise<void> {
  for (const endpoint of plan.readiness) {
    await waitForEndpoint(endpoint, plan.timeoutMs, fetchImpl, options);
  }
}

async function waitForEndpoint(
  endpoint: KubernetesSmokeEndpoint,
  timeoutMs: number,
  fetchImpl: typeof fetch,
  options: Pick<KubernetesSmokeCliOptions, "sleep" | "now">,
): Promise<void> {
  const startedAt = options.now?.() ?? Date.now();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while ((options.now?.() ?? Date.now()) - startedAt <= timeoutMs) {
    const response = await fetchImpl(endpoint.url).catch(() => null);
    if (response?.ok) return;
    await sleep(250);
  }

  throw new Error(`${endpoint.label} did not become ready within ${timeoutMs}ms`);
}

async function seedSmokeFixture(plan: KubernetesSmokePlan, serviceToken: string, fetchImpl: typeof fetch): Promise<unknown> {
  const response = await fetchImpl(plan.requests.seed.url, {
    method: "POST",
    headers: {
      [plan.serviceTokenHeaderName]: serviceToken,
      "content-type": "application/json",
    },
    body: JSON.stringify({}),
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(`deployed smoke seed failed with HTTP ${response.status}`);
  }
  return body;
}

async function waitForSmokeCompletion(
  plan: KubernetesSmokePlan,
  serviceToken: string,
  fetchImpl: typeof fetch,
  options: Pick<KubernetesSmokeCliOptions, "sleep" | "now">,
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
      throw new Error(`deployed smoke status failed with HTTP ${response.status}`);
    }
    if (isCompleteSmokeStatus(body)) return body;
    if (isFailedSmokeStatus(body)) {
      throw new Error("deployed smoke task failed before completion");
    }
    await sleep(250);
  }

  throw new Error(`deployed smoke timed out after ${plan.timeoutMs}ms`);
}

async function waitForPrometheusVerification(
  plan: KubernetesSmokePlan,
  fetchImpl: typeof fetch,
  options: Pick<KubernetesSmokeCliOptions, "sleep" | "now">,
): Promise<PrometheusVerification> {
  const startedAt = options.now?.() ?? Date.now();
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  while ((options.now?.() ?? Date.now()) - startedAt <= plan.timeoutMs) {
    const verification = await readPrometheusVerification({ prometheusUrl: plan.prometheusUrl }, fetchImpl);
    if (isPrometheusVerificationComplete(verification)) return verification;
    await sleep(250);
  }

  throw new Error(`Prometheus verification did not complete within ${plan.timeoutMs}ms`);
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

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}

if (import.meta.main) {
  const code = await runKubernetesSmokeCli();
  process.exit(code);
}
