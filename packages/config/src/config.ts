export type AuthMode = "test" | "local" | "external";
export type StorageAdapterKind = "local" | "blob";

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
  readonly projectTaskQueuePrefix: string;
  readonly projectControlQueuePrefix: string;
};

export type StorageConfig = {
  readonly adapter: StorageAdapterKind;
  readonly localRoot: string;
  readonly bucket: string;
};

export type AppConfig = {
  readonly authMode: AuthMode;
  readonly operator: OperatorIdentity;
  readonly serviceToken: ServiceTokenConfig;
  readonly backend: BackendServiceConfig;
  readonly bridge: BridgeSessionConfig;
  readonly orchestrator: OrchestratorServiceConfig;
  readonly rabbitmq: RabbitMqConfig;
  readonly storage: StorageConfig;
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
export const DEFAULT_BRIDGE_SESSION_TOKEN_HEADER = "x-agent-pool-session-token" as const;
export const DEFAULT_BACKEND_PORT = 3000;
export const DEFAULT_ORCHESTRATOR_PORT = 3001;
export const DEFAULT_BACKEND_INTERNAL_URL = `http://127.0.0.1:${DEFAULT_BACKEND_PORT}`;
export const DEFAULT_ORCHESTRATOR_URL = `http://127.0.0.1:${DEFAULT_ORCHESTRATOR_PORT}`;
export const DEFAULT_RABBITMQ_URL = "amqp://127.0.0.1:5672" as const;
export const DEFAULT_STORAGE_LOCAL_ROOT = ".agent-pool/web-sandbox/storage" as const;

const AUTH_MODES = new Set<AuthMode>(["test", "local", "external"]);
const STORAGE_ADAPTERS = new Set<StorageAdapterKind>(["local", "blob"]);

export function loadConfig(env: EnvSource = readProcessEnv()): AppConfig {
  const authMode = readAuthMode(env.AUTH_MODE);
  const serviceToken = readServiceTokenConfig(authMode, env);
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
      projectTaskQueuePrefix: env.RABBITMQ_PROJECT_TASK_QUEUE_PREFIX?.trim() || "project-tasks",
      projectControlQueuePrefix: env.RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX?.trim() || "project-control",
    },
    storage: {
      adapter: readStorageAdapter(env.STORAGE_ADAPTER),
      localRoot: env.STORAGE_LOCAL_ROOT?.trim() || DEFAULT_STORAGE_LOCAL_ROOT,
      bucket: env.STORAGE_BUCKET?.trim() || "agent-pool-web-sandbox",
    },
  };
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
