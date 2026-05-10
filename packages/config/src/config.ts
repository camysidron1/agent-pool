export type AuthMode = "test" | "local" | "external";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type OperatorIdentity = {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
};

export type AppConfig = {
  readonly authMode: AuthMode;
  readonly operator: OperatorIdentity;
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

const AUTH_MODES = new Set<AuthMode>(["test", "local", "external"]);

export function loadConfig(env: EnvSource = readProcessEnv()): AppConfig {
  const authMode = readAuthMode(env.AUTH_MODE);

  if (authMode === "test") {
    return {
      authMode,
      operator: TEST_OPERATOR_IDENTITY,
    };
  }

  return {
    authMode,
    operator: {
      id: requireEnv(env, "OPERATOR_ID"),
      email: requireEnv(env, "OPERATOR_EMAIL"),
      displayName: env.OPERATOR_DISPLAY_NAME?.trim() || requireEnv(env, "OPERATOR_EMAIL"),
    },
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
