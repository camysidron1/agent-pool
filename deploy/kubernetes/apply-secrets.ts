import { Buffer } from "node:buffer";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";

export type KubernetesSecretApplyPlan = {
  readonly namespace: string;
  readonly name: string;
  readonly envFile: string | null;
  readonly dryRun: boolean;
  readonly clusterRead: boolean;
  readonly requireE2B: boolean;
  readonly values: Readonly<Record<AgentPoolSecretKey, RedactedSecretValue>>;
};

export type RedactedSecretValue = {
  readonly state: "set" | "missing";
  readonly source: SecretSource;
};

type SecretSource = "cluster" | "env" | "env-file" | "generated" | "derived" | "default" | "missing";

type CliOptions = {
  readonly namespace: string;
  readonly name: string;
  readonly envFile: string | null;
  readonly dryRun: boolean;
  readonly clusterRead: boolean;
  readonly requireE2B: boolean;
};

type EnvSource = Readonly<Record<string, string | undefined>>;

type SecretOverrides = {
  readonly values: EnvSource;
  readonly sources: Readonly<Record<string, SecretSource>>;
};

type SecretBuildResult = {
  readonly values: Record<AgentPoolSecretKey, string>;
  readonly sources: Record<AgentPoolSecretKey, SecretSource>;
};

type ExistingSecretResult = {
  readonly values: Record<string, string>;
  readonly found: boolean;
};

type KubectlRunner = (args: readonly string[], options?: KubectlRunOptions) => Promise<KubectlRunResult>;

type KubectlRunOptions = {
  readonly stdin?: string;
  readonly capture?: boolean;
  readonly quiet?: boolean;
};

type KubectlRunResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type KubernetesSecretsCliOptions = {
  readonly env?: EnvSource;
  readonly write?: (text: string) => void;
  readonly kubectl?: KubectlRunner;
  readonly randomSecret?: (bytes: number) => string;
};

const DEFAULT_NAMESPACE = "agent-pool";
const DEFAULT_SECRET_NAME = "agent-pool-secrets";
const DEFAULT_ENV_FILE = ".env";
const DEFAULT_OPERATOR_ID = "operator-local";
const DEFAULT_OPERATOR_EMAIL = "operator@example.com";
const DEFAULT_OPERATOR_DISPLAY_NAME = "Agent Pool Operator";
const DEFAULT_RABBITMQ_DEFAULT_USER = "agent-pool";
const DEFAULT_MINIO_ROOT_USER = "agent-pool";
const DEFAULT_RABBITMQ_HOST = "agent-pool-rabbitmq.agent-pool.svc.cluster.local";
const DEFAULT_RABBITMQ_PORT = "5672";
const DEFAULT_RABBITMQ_MANAGEMENT_PORT = "15672";

const SECRET_KEYS = [
  "INTERNAL_SERVICE_TOKEN",
  "OPERATOR_ID",
  "OPERATOR_EMAIL",
  "OPERATOR_DISPLAY_NAME",
  "OPERATOR_PASSWORD",
  "PUBLIC_AUTH_SESSION_SECRET",
  "RABBITMQ_DEFAULT_USER",
  "RABBITMQ_DEFAULT_PASS",
  "RABBITMQ_URL",
  "RABBITMQ_MANAGEMENT_URL",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
  "E2B_API_KEY",
  "CODEX_API_KEY",
  "GITHUB_TOKEN",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
] as const;

type AgentPoolSecretKey = (typeof SECRET_KEYS)[number];

const REQUIRED_BASE_KEYS = [
  "INTERNAL_SERVICE_TOKEN",
  "OPERATOR_ID",
  "OPERATOR_EMAIL",
  "OPERATOR_DISPLAY_NAME",
  "OPERATOR_PASSWORD",
  "PUBLIC_AUTH_SESSION_SECRET",
  "RABBITMQ_DEFAULT_USER",
  "RABBITMQ_DEFAULT_PASS",
  "RABBITMQ_URL",
  "RABBITMQ_MANAGEMENT_URL",
  "MINIO_ROOT_USER",
  "MINIO_ROOT_PASSWORD",
] as const satisfies readonly AgentPoolSecretKey[];

const REQUIRED_E2B_KEYS = [
  "E2B_API_KEY",
  "CODEX_API_KEY",
  "GITHUB_APP_ID",
  "GITHUB_APP_PRIVATE_KEY",
  "GITHUB_APP_INSTALLATION_ID",
] as const satisfies readonly AgentPoolSecretKey[];

if (import.meta.main) {
  const code = await runKubernetesSecretsCli(Bun.argv.slice(2));
  process.exit(code);
}

export async function runKubernetesSecretsCli(
  args: readonly string[] = process.argv.slice(2),
  options: KubernetesSecretsCliOptions = {},
): Promise<number> {
  const env = options.env ?? readProcessEnv();
  const write = options.write ?? ((text: string) => process.stdout.write(text));
  const kubectl = options.kubectl ?? runKubectl;

  try {
    const parsed = parseKubernetesSecretsArgs(args, env);
    const envFileValues = parsed.envFile ? await readEnvFileIfPresent(parsed.envFile) : {};
    const overrides = mergeEnvSources(envFileValues, env);
    const existing = parsed.clusterRead && !parsed.dryRun ? await readExistingSecret(parsed, kubectl) : { found: false, values: {} };
    const secrets = buildAgentPoolSecrets({
      existing: existing.values,
      overrides,
      requireE2B: parsed.requireE2B,
      randomSecret: options.randomSecret ?? createRandomSecret,
    });
    const plan = createKubernetesSecretApplyPlan(parsed, secrets);

    if (parsed.dryRun) {
      write(`${JSON.stringify({ ok: true, existingSecretFound: existing.found, plan }, null, 2)}\n`);
      return 0;
    }

    await applyKubernetesSecret(parsed, secrets.values, kubectl);
    write(`${JSON.stringify({ ok: true, existingSecretFound: existing.found, plan }, null, 2)}\n`);
    return 0;
  } catch (error) {
    write(`${JSON.stringify({ ok: false, error: errorMessage(error) }, null, 2)}\n`);
    return 1;
  }
}

export function parseKubernetesSecretsArgs(args: readonly string[], env: EnvSource = readProcessEnv()): CliOptions {
  let namespace = env.KUBERNETES_NAMESPACE?.trim() || DEFAULT_NAMESPACE;
  let name = env.AGENT_POOL_SECRET_NAME?.trim() || DEFAULT_SECRET_NAME;
  let envFile: string | null = env.AGENT_POOL_SECRETS_FILE?.trim() || DEFAULT_ENV_FILE;
  let dryRun = false;
  let clusterRead = true;
  let requireE2B = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--namespace":
      case "-n":
        namespace = readFlag(args, (index += 1), arg);
        break;
      case "--name":
        name = readFlag(args, (index += 1), arg);
        break;
      case "--env-file":
        envFile = readFlag(args, (index += 1), arg);
        break;
      case "--no-env-file":
        envFile = null;
        break;
      case "--dry-run":
      case "--plan":
        dryRun = true;
        break;
      case "--no-cluster-read":
        clusterRead = false;
        break;
      case "--require-e2b":
        requireE2B = true;
        break;
      default:
        throw new Error(`unknown k8s:secrets:apply argument: ${arg}`);
    }
  }

  return {
    namespace: readKubernetesName(namespace, "namespace"),
    name: readKubernetesName(name, "secret name"),
    envFile,
    dryRun,
    clusterRead,
    requireE2B,
  };
}

export function buildAgentPoolSecrets(input: {
  readonly existing?: Readonly<Record<string, string>>;
  readonly overrides?: SecretOverrides;
  readonly requireE2B?: boolean;
  readonly randomSecret?: (bytes: number) => string;
}): SecretBuildResult {
  const existing = input.existing ?? {};
  const overrides = input.overrides ?? { values: {}, sources: {} };
  const randomSecret = input.randomSecret ?? createRandomSecret;
  const values = {} as Record<AgentPoolSecretKey, string>;
  const sources = {} as Record<AgentPoolSecretKey, SecretSource>;

  setValue(values, sources, "INTERNAL_SERVICE_TOKEN", readSecretValue("INTERNAL_SERVICE_TOKEN", { existing, overrides }));
  setValue(values, sources, "PUBLIC_AUTH_SESSION_SECRET", readSecretValue("PUBLIC_AUTH_SESSION_SECRET", { existing, overrides }));
  setValue(values, sources, "RABBITMQ_DEFAULT_PASS", readSecretValue("RABBITMQ_DEFAULT_PASS", { existing, overrides }));
  setValue(values, sources, "MINIO_ROOT_PASSWORD", readSecretValue("MINIO_ROOT_PASSWORD", { existing, overrides }));
  setValue(values, sources, "OPERATOR_PASSWORD", readSecretValue("OPERATOR_PASSWORD", { existing, overrides }));

  generateIfMissing(values, sources, "INTERNAL_SERVICE_TOKEN", 48, randomSecret);
  generateIfMissing(values, sources, "PUBLIC_AUTH_SESSION_SECRET", 48, randomSecret);
  generateIfMissing(values, sources, "RABBITMQ_DEFAULT_PASS", 32, randomSecret);
  generateIfMissing(values, sources, "MINIO_ROOT_PASSWORD", 32, randomSecret);

  setValue(
    values,
    sources,
    "OPERATOR_ID",
    readSecretValue("OPERATOR_ID", { existing, overrides }) ?? { value: DEFAULT_OPERATOR_ID, source: "default" },
  );
  setValue(
    values,
    sources,
    "OPERATOR_EMAIL",
    readSecretValue("OPERATOR_EMAIL", { existing, overrides }) ?? { value: DEFAULT_OPERATOR_EMAIL, source: "default" },
  );
  setValue(
    values,
    sources,
    "OPERATOR_DISPLAY_NAME",
    readSecretValue("OPERATOR_DISPLAY_NAME", { existing, overrides }) ?? {
      value: DEFAULT_OPERATOR_DISPLAY_NAME,
      source: "default",
    },
  );
  setValue(
    values,
    sources,
    "RABBITMQ_DEFAULT_USER",
    readSecretValue("RABBITMQ_DEFAULT_USER", { existing, overrides }) ?? {
      value: DEFAULT_RABBITMQ_DEFAULT_USER,
      source: "default",
    },
  );
  setValue(
    values,
    sources,
    "MINIO_ROOT_USER",
    readSecretValue("MINIO_ROOT_USER", { existing, overrides }) ?? { value: DEFAULT_MINIO_ROOT_USER, source: "default" },
  );

  const rabbitmqUrl = readSecretValue("RABBITMQ_URL", { existing, overrides });
  setValue(
    values,
    sources,
    "RABBITMQ_URL",
    rabbitmqUrl ?? {
      value: formatRabbitMqUrl({ user: values.RABBITMQ_DEFAULT_USER, password: values.RABBITMQ_DEFAULT_PASS, management: false }),
      source: "derived",
    },
  );

  const rabbitmqManagementUrl = readSecretValue("RABBITMQ_MANAGEMENT_URL", { existing, overrides });
  setValue(
    values,
    sources,
    "RABBITMQ_MANAGEMENT_URL",
    rabbitmqManagementUrl ?? {
      value: formatRabbitMqUrl({ user: values.RABBITMQ_DEFAULT_USER, password: values.RABBITMQ_DEFAULT_PASS, management: true }),
      source: "derived",
    },
  );

  setValue(values, sources, "E2B_API_KEY", readSecretValue("E2B_API_KEY", { existing, overrides }));
  setValue(values, sources, "CODEX_API_KEY", readSecretValue("CODEX_API_KEY", { existing, overrides }));
  setValue(values, sources, "GITHUB_TOKEN", readSecretValue("GITHUB_TOKEN", { existing, overrides }));
  setValue(values, sources, "GITHUB_APP_ID", readSecretValue("GITHUB_APP_ID", { existing, overrides }));
  setValue(values, sources, "GITHUB_APP_PRIVATE_KEY", readSecretValue("GITHUB_APP_PRIVATE_KEY", { existing, overrides }));
  setValue(values, sources, "GITHUB_APP_INSTALLATION_ID", readSecretValue("GITHUB_APP_INSTALLATION_ID", { existing, overrides }));

  validateSecrets(values, Boolean(input.requireE2B));

  return { values, sources };
}

export function createKubernetesSecretApplyPlan(options: CliOptions, secrets: SecretBuildResult): KubernetesSecretApplyPlan {
  const values = {} as Record<AgentPoolSecretKey, RedactedSecretValue>;
  for (const key of SECRET_KEYS) {
    values[key] = {
      state: secrets.values[key]?.trim() ? "set" : "missing",
      source: secrets.sources[key] ?? "missing",
    };
  }

  return {
    namespace: options.namespace,
    name: options.name,
    envFile: options.envFile,
    dryRun: options.dryRun,
    clusterRead: options.clusterRead,
    requireE2B: options.requireE2B,
    values,
  };
}

async function applyKubernetesSecret(options: CliOptions, values: Readonly<Record<AgentPoolSecretKey, string>>, kubectl: KubectlRunner): Promise<void> {
  const manifest = {
    apiVersion: "v1",
    kind: "Secret",
    metadata: {
      name: options.name,
      namespace: options.namespace,
    },
    type: "Opaque",
    stringData: values,
  };

  const result = await kubectl(["apply", "-f", "-"], {
    stdin: `${JSON.stringify(manifest)}\n`,
    capture: true,
  });

  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || `kubectl apply failed with exit code ${result.exitCode}`);
  }
}

async function readExistingSecret(options: CliOptions, kubectl: KubectlRunner): Promise<ExistingSecretResult> {
  const result = await kubectl(["-n", options.namespace, "get", "secret", options.name, "-o", "json"], {
    capture: true,
    quiet: true,
  });

  if (result.exitCode !== 0) {
    return { found: false, values: {} };
  }

  const parsed = JSON.parse(result.stdout) as { readonly data?: Readonly<Record<string, string>> };
  const values: Record<string, string> = {};
  for (const [key, value] of Object.entries(parsed.data ?? {})) {
    values[key] = Buffer.from(value, "base64").toString("utf8");
  }

  return { found: true, values };
}

async function runKubectl(args: readonly string[], options: KubectlRunOptions = {}): Promise<KubectlRunResult> {
  const child = Bun.spawn(["kubectl", ...args], {
    stdin: options.stdin ? "pipe" : "ignore",
    stdout: options.capture ? "pipe" : "inherit",
    stderr: options.capture || options.quiet ? "pipe" : "inherit",
  });

  if (options.stdin && child.stdin) {
    child.stdin.write(options.stdin);
    child.stdin.end();
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    options.capture ? new Response(child.stdout).text() : Promise.resolve(""),
    options.capture || options.quiet ? new Response(child.stderr).text() : Promise.resolve(""),
    child.exited,
  ]);

  return { exitCode, stdout, stderr };
}

async function readEnvFileIfPresent(path: string): Promise<Record<string, string>> {
  if (!existsSync(path)) return {};
  const text = await readFile(path, "utf8");
  return parseEnvFile(text);
}

export function parseEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error("secrets env file lines must use KEY=value syntax");
    }

    const key = line.slice(0, equalsIndex).trim();
    const rawValue = line.slice(equalsIndex + 1).trim();
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key)) {
      throw new Error(`invalid secrets env file key: ${key}`);
    }

    values[key] = unquoteEnvValue(rawValue);
  }

  return values;
}

function mergeEnvSources(envFileValues: EnvSource, envValues: EnvSource): SecretOverrides {
  const values: Record<string, string> = {};
  const sources: Record<string, SecretSource> = {};

  for (const [key, value] of Object.entries(envFileValues)) {
    if (value?.trim()) {
      values[key] = value;
      sources[key] = "env-file";
    }
  }

  for (const [key, value] of Object.entries(envValues)) {
    if (value?.trim()) {
      values[key] = value;
      sources[key] = "env";
    }
  }

  return { values, sources };
}

function readSecretValue(
  key: AgentPoolSecretKey,
  input: { readonly existing: Readonly<Record<string, string>>; readonly overrides: SecretOverrides },
): { readonly value: string; readonly source: SecretSource } | null {
  const override = input.overrides.values[key]?.trim();
  if (override) {
    return { value: override, source: input.overrides.sources[key] ?? "env" };
  }

  const existing = input.existing[key]?.trim();
  if (existing) {
    return { value: existing, source: "cluster" };
  }

  return null;
}

function setValue(
  values: Record<AgentPoolSecretKey, string>,
  sources: Record<AgentPoolSecretKey, SecretSource>,
  key: AgentPoolSecretKey,
  input: { readonly value: string; readonly source: SecretSource } | null,
): void {
  values[key] = input?.value ?? "";
  sources[key] = input?.source ?? "missing";
}

function generateIfMissing(
  values: Record<AgentPoolSecretKey, string>,
  sources: Record<AgentPoolSecretKey, SecretSource>,
  key: AgentPoolSecretKey,
  bytes: number,
  randomSecret: (bytes: number) => string,
): void {
  if (values[key]) return;
  values[key] = randomSecret(bytes);
  sources[key] = "generated";
}

function validateSecrets(values: Readonly<Record<AgentPoolSecretKey, string>>, requireE2B: boolean): void {
  const required = requireE2B ? [...REQUIRED_BASE_KEYS, ...REQUIRED_E2B_KEYS] : REQUIRED_BASE_KEYS;
  const missing = required.filter((key) => !values[key]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing required secret values: ${missing.join(", ")}`);
  }

  if (values.OPERATOR_PASSWORD.length < 12) {
    throw new Error("OPERATOR_PASSWORD must be at least 12 characters");
  }

  if (values.PUBLIC_AUTH_SESSION_SECRET.length < 32) {
    throw new Error("PUBLIC_AUTH_SESSION_SECRET must be at least 32 characters");
  }
}

function formatRabbitMqUrl(input: { readonly user: string; readonly password: string; readonly management: boolean }): string {
  const protocol = input.management ? "http" : "amqp";
  const port = input.management ? DEFAULT_RABBITMQ_MANAGEMENT_PORT : DEFAULT_RABBITMQ_PORT;
  return `${protocol}://${encodeURIComponent(input.user)}:${encodeURIComponent(input.password)}@${DEFAULT_RABBITMQ_HOST}:${port}`;
}

function createRandomSecret(bytes: number): string {
  return randomBytes(bytes).toString("base64url");
}

function unquoteEnvValue(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1).replaceAll('\\"', '"').replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function readFlag(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readKubernetesName(value: string, label: string): string {
  const trimmed = value.trim();
  if (/^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/.test(trimmed)) return trimmed;
  throw new Error(`invalid Kubernetes ${label}: ${value}`);
}

function readProcessEnv(): EnvSource {
  return process.env;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
