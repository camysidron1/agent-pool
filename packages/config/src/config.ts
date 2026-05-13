export type AuthMode = "test" | "local" | "external";
export type StorageAdapterKind = "local" | "blob";
export type RuntimeProviderName = "fake" | "e2b" | "docker";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type OperatorIdentity = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
};

export type ServiceTokenConfig = {
  readonly token: string;
  readonly headerName: string;
};

export type PublicAuthConfig = {
  readonly operatorPassword: string | null;
  readonly sessionSecret: string | null;
  readonly cookieName: string;
  readonly cookieSecure: boolean;
  readonly sessionTtlSeconds: number;
};

export type BackendServiceConfig = {
  readonly port: number;
  readonly publicUrl: string;
  readonly internalUrl: string;
};

export type BridgeSessionConfig = {
  readonly callbackBaseUrl: string;
  readonly sessionTokenHeaderName: string;
};

export type OrchestratorServiceConfig = {
  readonly port: number;
  readonly publicUrl: string;
  readonly backendInternalUrl: string;
};

export type RabbitMqConfig = {
  readonly url: string;
  readonly managementUrl: string;
  readonly projectTaskQueuePrefix: string;
  readonly projectControlQueuePrefix: string;
};

export type StorageConfig = {
  readonly adapter: StorageAdapterKind;
  readonly localRoot: string;
  readonly bucket: string;
};

export type E2BRuntimeConfig = {
  readonly apiKeyEnvName: string;
  readonly apiKeyConfigured: boolean;
  readonly templateId: string | null;
  readonly sandboxImageId: string | null;
  readonly workingDirectory: string;
  readonly startupTimeoutMs: number;
  readonly cleanupTimeoutMs: number;
  readonly githubTokenEnvName: string;
  readonly githubTokenConfigured: boolean;
  readonly allowedSecretEnvNames: readonly string[];
};

export type ControlPlaneRuntimeConfig = {
  readonly runtimeProvider: RuntimeProviderName;
  readonly smokeEnabled: boolean;
  readonly smokeProjectId: string;
  readonly workerPollIntervalMs: number;
  readonly outboxPublishIntervalMs: number;
  readonly reconcileIntervalMs: number;
  readonly e2b: E2BRuntimeConfig;
};

export type AppConfig = {
  readonly authMode: AuthMode;
  readonly operator: OperatorIdentity;
  readonly serviceToken: ServiceTokenConfig;
  readonly publicAuth: PublicAuthConfig;
  readonly backend: BackendServiceConfig;
  readonly bridge: BridgeSessionConfig;
  readonly orchestrator: OrchestratorServiceConfig;
  readonly rabbitmq: RabbitMqConfig;
  readonly storage: StorageConfig;
  readonly controlPlane: ControlPlaneRuntimeConfig;
};

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export const TEST_OPERATOR_IDENTITY: OperatorIdentity = {
  id: "test-operator",
  email: "test-operator@example.test",
  displayName: "Test Operator",
};

export const DEFAULT_SERVICE_TOKEN = "test-service-token" as const;
export const DEFAULT_SERVICE_TOKEN_HEADER = "x-agent-pool-service-token" as const;
export const DEFAULT_PUBLIC_AUTH_PASSWORD = "test-operator-password" as const;
export const DEFAULT_PUBLIC_AUTH_SESSION_SECRET = "test-public-auth-session-secret-000000000000" as const;
export const DEFAULT_PUBLIC_AUTH_COOKIE_NAME = "agent_pool_session" as const;
export const DEFAULT_PUBLIC_AUTH_SESSION_TTL_SECONDS = 86_400;
export const DEFAULT_BRIDGE_SESSION_TOKEN_HEADER = "x-agent-pool-session-token" as const;
export const DEFAULT_BACKEND_PORT = 3000;
export const DEFAULT_ORCHESTRATOR_PORT = 3001;
export const DEFAULT_BACKEND_INTERNAL_URL = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
export const DEFAULT_ORCHESTRATOR_URL = `http://127.0.0.1:${DEFAULT_ORCHESTRATOR_PORT}`;
export const DEFAULT_RABBITMQ_URL = "amqp://127.0.0.1:5672" as const;
export const DEFAULT_RABBITMQ_MANAGEMENT_URL = "http://guest:guest@127.0.0.1:15672" as const;
export const DEFAULT_STORAGE_LOCAL_ROOT = ".agent-pool/web-sandbox/storage" as const;
export const DEFAULT_RUNTIME_PROVIDER = "fake" as const;
export const DEFAULT_E2B_API_KEY_ENV_NAME = "E2B_API_KEY" as const;
export const DEFAULT_E2B_GITHUB_TOKEN_ENV_NAME = "GITHUB_TOKEN" as const;
export const DEFAULT_E2B_WORKING_DIRECTORY = "/workspace/agent-pool" as const;
export const DEFAULT_E2B_STARTUP_TIMEOUT_MS = 120_000;
export const DEFAULT_E2B_CLEANUP_TIMEOUT_MS = 30_000;
export const DEFAULT_CONTROL_PLANE_SMOKE_PROJECT_ID = "compose-smoke" as const;
export const DEFAULT_CONTROL_PLANE_WORKER_POLL_INTERVAL_MS = 1000;
export const DEFAULT_CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS = 1000;
export const DEFAULT_CONTROL_PLANE_RECONCILE_INTERVAL_MS = 5000;

const AUTH_MODES = new Set<AuthMode>(["test", "local", "external"]);
const STORAGE_ADAPTERS = new Set<StorageAdapterKind>(["local", "blob"]);
const RUNTIME_PROVIDERS = new Set<RuntimeProviderName>(["fake", "e2b", "docker"]);

export function loadConfig(env: EnvSource = readProcessEnv()): AppConfig {
  const authMode = readAuthMode(env.AUTH_MODE);
  const serviceToken = readServiceTokenConfig(authMode, env);
  const runtimeProvider = readRuntimeProvider(env.RUNTIME_PROVIDER);
  const e2b = readE2BRuntimeConfig(env, runtimeProvider);
  const backend = {
    port: readPort(env.API_PORT, DEFAULT_BACKEND_PORT, "API_PORT"),
    publicUrl: readOptionalUrl(env.API_PUBLIC_URL, DEFAULT_BACKEND_INTERNAL_URL, "API_PUBLIC_URL"),
    internalUrl: readOptionalUrl(env.API_INTERNAL_URL, DEFAULT_BACKEND_INTERNAL_URL, "API_INTERNAL_URL"),
  };
  const bridge = readBridgeSessionConfig(env, backend, serviceToken);

  return {
    authMode,
    operator: readOperator(authMode, env),
    serviceToken,
    publicAuth: readPublicAuthConfig(authMode, backend, env),
    backend,
    bridge,
    orchestrator: {
      port: readPort(env.ORCHESTRATOR_PORT, DEFAULT_ORCHESTRATOR_PORT, "ORCHESTRATOR_PORT"),
      publicUrl: readOptionalUrl(env.ORCHESTRATOR_PUBLIC_URL, DEFAULT_ORCHESTRATOR_URL, "ORCHESTRATOR_PUBLIC_URL"),
      backendInternalUrl: readOptionalUrl(
        env.ORCHESTRATOR_BACKEND_INTERNAL_URL,
        DEFAULT_BACKEND_INTERNAL_URL,
        "ORCHESTRATOR_BACKEND_INTERNAL_URL",
      ),
    },
    rabbitmq: {
      url: readOptionalUrl(env.RABBITMQ_URL, DEFAULT_RABBITMQ_URL, "RABBITMQ_URL"),
      managementUrl: readOptionalUrl(
        env.RABBITMQ_MANAGEMENT_URL,
        DEFAULT_RABBITMQ_MANAGEMENT_URL,
        "RABBITMQ_MANAGEMENT_URL",
      ),
      projectTaskQueuePrefix: env.RABBITMQ_PROJECT_TASK_QUEUE_PREFIX?.trim() || "project-tasks",
      projectControlQueuePrefix: env.RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX?.trim() || "project-control",
    },
    storage: {
      adapter: readStorageAdapter(env.STORAGE_ADAPTER),
      localRoot: env.STORAGE_LOCAL_ROOT?.trim() || DEFAULT_STORAGE_LOCAL_ROOT,
      bucket: env.STORAGE_BUCKET?.trim() || "agent-pool-web-sandbox",
    },
    controlPlane: {
      runtimeProvider,
      smokeEnabled: readBoolean(env.COMPOSE_SMOKE_ENABLED, authMode === "test", "COMPOSE_SMOKE_ENABLED"),
      smokeProjectId: readRequiredIdentifier(
        env.COMPOSE_SMOKE_PROJECT_ID,
        DEFAULT_CONTROL_PLANE_SMOKE_PROJECT_ID,
        "COMPOSE_SMOKE_PROJECT_ID",
      ),
      workerPollIntervalMs: readPositiveInteger(
        env.CONTROL_PLANE_WORKER_POLL_INTERVAL_MS,
        DEFAULT_CONTROL_PLANE_WORKER_POLL_INTERVAL_MS,
        "CONTROL_PLANE_WORKER_POLL_INTERVAL_MS",
      ),
      outboxPublishIntervalMs: readPositiveInteger(
        env.CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS,
        DEFAULT_CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS,
        "CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS",
      ),
      reconcileIntervalMs: readPositiveInteger(
        env.CONTROL_PLANE_RECONCILE_INTERVAL_MS,
        DEFAULT_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
        "CONTROL_PLANE_RECONCILE_INTERVAL_MS",
      ),
      e2b,
    },
  };
}

function readE2BRuntimeConfig(env: EnvSource, runtimeProvider: RuntimeProviderName): E2BRuntimeConfig {
  const apiKeyEnvName = readEnvVarName(env.E2B_API_KEY_ENV_NAME, DEFAULT_E2B_API_KEY_ENV_NAME, "E2B_API_KEY_ENV_NAME");
  const githubTokenEnvName = readEnvVarName(
    env.E2B_GITHUB_TOKEN_ENV_NAME,
    DEFAULT_E2B_GITHUB_TOKEN_ENV_NAME,
    "E2B_GITHUB_TOKEN_ENV_NAME",
  );
  const allowedSecretEnvNames = readEnvVarNameList(env.E2B_ALLOWED_SECRET_ENV_NAMES, "E2B_ALLOWED_SECRET_ENV_NAMES");
  const templateId = readOptionalIdentifier(env.E2B_TEMPLATE_ID, "E2B_TEMPLATE_ID");
  const sandboxImageId = readOptionalIdentifier(env.E2B_SANDBOX_IMAGE_ID, "E2B_SANDBOX_IMAGE_ID");
  const config: E2BRuntimeConfig = {
    apiKeyEnvName,
    apiKeyConfigured: Boolean(env[apiKeyEnvName]?.trim()),
    templateId,
    sandboxImageId,
    workingDirectory: readSandboxWorkingDirectory(env.E2B_WORKING_DIRECTORY),
    startupTimeoutMs: readPositiveInteger(
      env.E2B_STARTUP_TIMEOUT_MS,
      DEFAULT_E2B_STARTUP_TIMEOUT_MS,
      "E2B_STARTUP_TIMEOUT_MS",
    ),
    cleanupTimeoutMs: readPositiveInteger(
      env.E2B_CLEANUP_TIMEOUT_MS,
      DEFAULT_E2B_CLEANUP_TIMEOUT_MS,
      "E2B_CLEANUP_TIMEOUT_MS",
    ),
    githubTokenEnvName,
    githubTokenConfigured: Boolean(env[githubTokenEnvName]?.trim()),
    allowedSecretEnvNames,
  };

  if (runtimeProvider === "e2b") {
    if (!config.apiKeyConfigured) {
      throw new ConfigError(`${config.apiKeyEnvName} is required when RUNTIME_PROVIDER=e2b.`);
    }
    if (!config.templateId && !config.sandboxImageId) {
      throw new ConfigError("E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID is required when RUNTIME_PROVIDER=e2b.");
    }
  }

  return config;
}

function readBridgeSessionConfig(
  env: EnvSource,
  backend: BackendServiceConfig,
  serviceToken: ServiceTokenConfig,
): BridgeSessionConfig {
  const sessionTokenHeaderName = (env.BRIDGE_SESSION_TOKEN_HEADER?.trim() || DEFAULT_BRIDGE_SESSION_TOKEN_HEADER).toLowerCase();

  if (sessionTokenHeaderName === serviceToken.headerName) {
    throw new ConfigError("BRIDGE_SESSION_TOKEN_HEADER must be distinct from the internal service token header.");
  }

  return {
    callbackBaseUrl: readOptionalUrl(env.BRIDGE_CALLBACK_BASE_URL, backend.internalUrl, "BRIDGE_CALLBACK_BASE_URL"),
    sessionTokenHeaderName,
  };
}

function readOperator(authMode: AuthMode, env: EnvSource): OperatorIdentity {
  if (authMode === "test") {
    return TEST_OPERATOR_IDENTITY;
  }

  return {
    id: requireEnv(env, "OPERATOR_ID"),
    email: requireEnv(env, "OPERATOR_EMAIL"),
    displayName: env.OPERATOR_DISPLAY_NAME?.trim() || requireEnv(env, "OPERATOR_EMAIL"),
  };
}

function readServiceTokenConfig(authMode: AuthMode, env: EnvSource): ServiceTokenConfig {
  const token = env.INTERNAL_SERVICE_TOKEN?.trim();

  if (!token && authMode !== "test") {
    throw new ConfigError("INTERNAL_SERVICE_TOKEN is required when AUTH_MODE is not test.");
  }

  return {
    token: token || DEFAULT_SERVICE_TOKEN,
    headerName: env.INTERNAL_SERVICE_TOKEN_HEADER?.trim().toLowerCase() || DEFAULT_SERVICE_TOKEN_HEADER,
  };
}

function readPublicAuthConfig(authMode: AuthMode, backend: BackendServiceConfig, env: EnvSource): PublicAuthConfig {
  const operatorPassword =
    env.OPERATOR_PASSWORD?.trim() || (authMode === "test" ? DEFAULT_PUBLIC_AUTH_PASSWORD : null);
  const sessionSecret =
    env.PUBLIC_AUTH_SESSION_SECRET?.trim() || (authMode === "test" ? DEFAULT_PUBLIC_AUTH_SESSION_SECRET : null);
  const cookieName = env.PUBLIC_AUTH_COOKIE_NAME?.trim() || DEFAULT_PUBLIC_AUTH_COOKIE_NAME;

  if (operatorPassword !== null && operatorPassword.length < 12) {
    throw new ConfigError("OPERATOR_PASSWORD must be at least 12 characters.");
  }
  if (sessionSecret !== null && sessionSecret.length < 32) {
    throw new ConfigError("PUBLIC_AUTH_SESSION_SECRET must be at least 32 characters.");
  }
  if (!/^[A-Za-z0-9_-]+$/.test(cookieName)) {
    throw new ConfigError("PUBLIC_AUTH_COOKIE_NAME must contain only letters, numbers, underscores, or hyphens.");
  }

  return {
    operatorPassword,
    sessionSecret,
    cookieName,
    cookieSecure: readBoolean(
      env.PUBLIC_AUTH_COOKIE_SECURE,
      authMode !== "test" && backend.publicUrl.startsWith("https://"),
      "PUBLIC_AUTH_COOKIE_SECURE",
    ),
    sessionTtlSeconds: readPositiveInteger(
      env.PUBLIC_AUTH_SESSION_TTL_SECONDS,
      DEFAULT_PUBLIC_AUTH_SESSION_TTL_SECONDS,
      "PUBLIC_AUTH_SESSION_TTL_SECONDS",
    ),
  };
}

function readAuthMode(value: string | undefined): AuthMode {
  const authMode = value?.trim();

  if (!authMode) {
    throw new ConfigError("AUTH_MODE is required.");
  }

  if (AUTH_MODES.has(authMode as AuthMode)) {
    return authMode as AuthMode;
  }

  throw new ConfigError(`AUTH_MODE must be one of: ${Array.from(AUTH_MODES).join(", ")}.`);
}

function readStorageAdapter(value: string | undefined): StorageAdapterKind {
  const adapter = value?.trim() || "local";

  if (STORAGE_ADAPTERS.has(adapter as StorageAdapterKind)) {
    return adapter as StorageAdapterKind;
  }

  throw new ConfigError(`STORAGE_ADAPTER must be one of: ${Array.from(STORAGE_ADAPTERS).join(", ")}.`);
}

function readRuntimeProvider(value: string | undefined): RuntimeProviderName {
  const provider = value?.trim() || DEFAULT_RUNTIME_PROVIDER;

  if (RUNTIME_PROVIDERS.has(provider as RuntimeProviderName)) {
    return provider as RuntimeProviderName;
  }

  throw new ConfigError(`RUNTIME_PROVIDER must be one of: ${Array.from(RUNTIME_PROVIDERS).join(", ")}.`);
}

function readOptionalIdentifier(value: string | undefined, name: string): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9._:-]+$/.test(raw)) return raw;
  throw new ConfigError(`${name} must contain only letters, numbers, dots, underscores, colons, or hyphens.`);
}

function readEnvVarName(value: string | undefined, defaultValue: string, name: string): string {
  const raw = value?.trim() || defaultValue;
  if (/^[A-Z_][A-Z0-9_]*$/.test(raw)) return raw;
  throw new ConfigError(`${name} must be an uppercase environment variable name.`);
}

function readEnvVarNameList(value: string | undefined, name: string): readonly string[] {
  const raw = value?.trim();
  if (!raw) return [];
  const names = raw.split(",").map((part) => readEnvVarName(part, "", name));
  return [...new Set(names)];
}

function readSandboxWorkingDirectory(value: string | undefined): string {
  const raw = value?.trim() || DEFAULT_E2B_WORKING_DIRECTORY;
  if (!raw.startsWith("/")) {
    throw new ConfigError("E2B_WORKING_DIRECTORY must be an absolute sandbox path.");
  }
  if (raw.includes("..") || raw.includes("~") || raw.includes(".agent-pool/data/agent-pool.db")) {
    throw new ConfigError("E2B_WORKING_DIRECTORY must not escape the sandbox workspace or reference the TUI database.");
  }
  return raw.replace(/\/+$/, "") || "/";
}

function readBoolean(value: string | undefined, defaultValue: boolean, name: string): boolean {
  const raw = value?.trim().toLowerCase();
  if (!raw) return defaultValue;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  throw new ConfigError(`${name} must be a boolean value.`);
}

function readRequiredIdentifier(value: string | undefined, defaultValue: string, name: string): string {
  const raw = value?.trim() || defaultValue;
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  throw new ConfigError(`${name} must contain only letters, numbers, underscores, or hyphens.`);
}

function readPositiveInteger(value: string | undefined, defaultValue: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;
  const number = Number(raw);

  if (!Number.isInteger(number) || number < 1) {
    throw new ConfigError(`${name} must be a positive integer.`);
  }

  return number;
}

function readPort(value: string | undefined, defaultValue: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return defaultValue;
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ConfigError(`${name} must be an integer port between 1 and 65535.`);
  }

  return port;
}

function readOptionalUrl(value: string | undefined, defaultValue: string, name: string): string {
  const raw = value?.trim() || defaultValue;

  try {
    return new URL(raw).toString().replace(/\/$/, "");
  } catch {
    throw new ConfigError(`${name} must be a valid URL.`);
  }
}

function requireEnv(env: EnvSource, name: string): string {
  const value = env[name]?.trim();

  if (!value) {
    throw new ConfigError(`${name} is required when AUTH_MODE is not test.`);
  }

  return value;
}

function readProcessEnv(): EnvSource {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: EnvSource;
    };
  };

  return processLike.process?.env ?? {};
}
