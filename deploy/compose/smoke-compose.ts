import { resolve } from "node:path";

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
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly teardown: boolean;
  readonly commands: readonly ComposeSmokeCommand[];
  readonly readiness: readonly ComposeSmokeEndpoint[];
};

export type ComposeSmokeCliOptions = {
  readonly cwd?: string;
  readonly write?: (text: string) => void;
  readonly runCommand?: (command: readonly string[], options: { readonly cwd: string }) => Promise<void>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
};

type ParsedComposeSmokeArgs = {
  readonly dryRun: boolean;
  readonly composeFile?: string;
  readonly projectName: string;
  readonly apiUrl: string;
  readonly orchestratorUrl: string;
  readonly serviceToken: string;
  readonly timeoutMs: number;
  readonly teardown: boolean;
};

const DEFAULT_PROJECT_NAME = "agent-pool-compose-smoke";
const DEFAULT_API_URL = "http://127.0.0.1:3000";
const DEFAULT_ORCHESTRATOR_URL = "http://127.0.0.1:3001";
const DEFAULT_SERVICE_TOKEN = "compose-internal-service-token";
const DEFAULT_TIMEOUT_MS = 120_000;

export function createComposeSmokePlan(input: Partial<ParsedComposeSmokeArgs> & { readonly cwd?: string } = {}): ComposeSmokePlan {
  const cwd = input.cwd ?? process.cwd();
  const composeFile = resolve(cwd, input.composeFile ?? "deploy/compose/docker-compose.yml");
  const projectName = input.projectName ?? DEFAULT_PROJECT_NAME;
  const apiUrl = trimTrailingSlash(input.apiUrl ?? DEFAULT_API_URL);
  const orchestratorUrl = trimTrailingSlash(input.orchestratorUrl ?? DEFAULT_ORCHESTRATOR_URL);
  const serviceToken = input.serviceToken ?? DEFAULT_SERVICE_TOKEN;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const teardown = input.teardown ?? true;

  return {
    composeFile,
    projectName,
    apiUrl,
    orchestratorUrl,
    serviceToken,
    timeoutMs,
    teardown,
    commands: [
      {
        label: "boot compose stack",
        command: ["docker", "compose", "-f", composeFile, "-p", projectName, "up", "-d", "--wait"],
      },
      {
        label: "tear down compose stack",
        command: ["docker", "compose", "-f", composeFile, "-p", projectName, "down", "-v", "--remove-orphans"],
      },
    ],
    readiness: [
      { label: "api health", url: `${apiUrl}/health` },
      { label: "orchestrator health", url: `${orchestratorUrl}/health` },
      { label: "rabbitmq management", url: "http://127.0.0.1:15672/api/overview" },
      { label: "minio readiness", url: "http://127.0.0.1:9000/minio/health/ready" },
      { label: "prometheus health", url: "http://127.0.0.1:9090/-/healthy" },
    ],
  };
}

export async function runComposeSmokeCli(args: readonly string[] = process.argv.slice(2), options: ComposeSmokeCliOptions = {}): Promise<number> {
  const parsed = parseComposeSmokeArgs(args);
  const cwd = options.cwd ?? process.cwd();
  const plan = createComposeSmokePlan({ ...parsed, cwd });
  const write = options.write ?? ((text: string) => process.stdout.write(text));

  if (parsed.dryRun) {
    write(`${JSON.stringify(plan, null, 2)}\n`);
    return 0;
  }

  const runCommand = options.runCommand ?? runSubprocess;
  const fetchImpl = options.fetch ?? fetch;

  try {
    await runCommand(plan.commands[0].command, { cwd });
    await waitForReadiness(plan, fetchImpl, options);
    await seedSmokeFixture(plan, fetchImpl);
    const status = await waitForSmokeCompletion(plan, fetchImpl, options);
    write(`${JSON.stringify({ ok: true, status }, null, 2)}\n`);
    return 0;
  } finally {
    if (plan.teardown) {
      await runCommand(plan.commands[1].command, { cwd });
    }
  }
}

export function parseComposeSmokeArgs(args: readonly string[]): ParsedComposeSmokeArgs {
  let dryRun = false;
  let composeFile: string | undefined;
  let projectName = DEFAULT_PROJECT_NAME;
  let apiUrl = DEFAULT_API_URL;
  let orchestratorUrl = DEFAULT_ORCHESTRATOR_URL;
  let serviceToken = DEFAULT_SERVICE_TOKEN;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let teardown = true;

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
      case "--service-token":
        serviceToken = readFlagValue(args, (index += 1), arg);
        break;
      case "--timeout-ms":
        timeoutMs = readPositiveInteger(readFlagValue(args, (index += 1), arg), arg);
        break;
      case "--no-teardown":
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
    serviceToken,
    timeoutMs,
    teardown,
  };
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

async function runSubprocess(command: readonly string[], options: { readonly cwd: string }): Promise<void> {
  const process = Bun.spawn(command, {
    cwd: options.cwd,
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await process.exited;

  if (status !== 0) {
    throw new Error(`command failed (${status}): ${command.join(" ")}`);
  }
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
