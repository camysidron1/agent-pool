import type {
  E2BCommandResult,
  E2BCommandRunOptions,
  E2BDestroySandboxOptions,
  E2BRuntimeClient,
  E2BSandboxCreateInput,
} from "@agent-pool/runtime";

type E2BSdkCommandStartOptions = {
  readonly envs?: Record<string, string>;
  readonly onStderr?: (data: string) => void | Promise<void>;
  readonly onStdout?: (data: string) => void | Promise<void>;
  readonly requestTimeoutMs?: number;
  readonly timeoutMs?: number;
};

type E2BSdkCommandResult = {
  readonly exitCode?: number;
  readonly stdout?: string;
  readonly stderr?: string;
  readonly error?: string;
};

type E2BSdkSandboxCreateOptions = {
  readonly apiKey?: string;
  readonly envs?: Record<string, string>;
  readonly metadata?: Record<string, string>;
  readonly requestTimeoutMs?: number;
  readonly secure?: boolean;
  readonly allowInternetAccess?: boolean;
};

type E2BSdkSandboxApiOptions = {
  readonly apiKey?: string;
  readonly requestTimeoutMs?: number;
};

type E2BSdkSandbox = {
  readonly sandboxId: string;
  readonly commands: {
    readonly run: (command: string, options?: E2BSdkCommandStartOptions) => Promise<E2BSdkCommandResult>;
  };
  readonly kill: (options?: Pick<E2BSdkSandboxApiOptions, "requestTimeoutMs">) => Promise<void>;
};

type E2BSdkSandboxConstructor = {
  readonly create: (template: string, options?: E2BSdkSandboxCreateOptions) => Promise<E2BSdkSandbox>;
  readonly connect: (sandboxId: string, options?: E2BSdkSandboxApiOptions) => Promise<E2BSdkSandbox>;
  readonly kill: (sandboxId: string, options?: E2BSdkSandboxApiOptions) => Promise<boolean>;
};

export type E2BSdkLoader = () => Promise<{ readonly Sandbox: E2BSdkSandboxConstructor }>;

export type CreateE2BRuntimeClientOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly apiKeyEnvName?: string;
  readonly loadSdk?: E2BSdkLoader;
};

export function createE2BRuntimeClient(options: CreateE2BRuntimeClientOptions = {}): E2BRuntimeClient {
  const loadSdk = options.loadSdk ?? loadE2BSdk;
  const env = options.env ?? readProcessEnv();
  const apiKeyEnvName = sanitizeEnvName(options.apiKeyEnvName ?? "E2B_API_KEY");
  const sandboxes = new Map<string, E2BSdkSandbox>();

  return {
    async createSandbox(input): Promise<{ readonly sandboxId: string }> {
      const { Sandbox } = await loadSdk();
      const apiKey = readRequiredEnv(env, apiKeyEnvName);
      const template = readSandboxTemplate(input);
      const createOptions = createSandboxOptions(input, apiKey);
      const sandbox = await Sandbox.create(template, createOptions);
      const sandboxId = readSandboxId(sandbox.sandboxId);

      sandboxes.set(sandboxId, sandbox);
      return { sandboxId };
    },
    async runCommand(sandboxId, command, commandOptions): Promise<E2BCommandResult> {
      const sandbox = await getSandbox(sandboxId);
      const shellCommand = serializeE2BCommand(command);
      const stdout: string[] = [];
      const stderr: string[] = [];

      try {
        const result = await sandbox.commands.run(shellCommand, {
          envs: commandOptions.env ? { ...commandOptions.env } : undefined,
          onStdout: (data) => {
            stdout.push(data);
          },
          onStderr: (data) => {
            stderr.push(data);
          },
          timeoutMs: commandOptions.timeoutMs,
          requestTimeoutMs: commandOptions.timeoutMs,
        });

        return normalizeCommandResult(result, stdout, stderr);
      } catch (error) {
        const result = readCommandFailure(error);
        if (result) return normalizeCommandResult(result, stdout, stderr);
        throw error;
      }
    },
    async destroySandbox(sandboxId, destroyOptions): Promise<void> {
      const normalizedSandboxId = readSandboxId(sandboxId);
      const cached = sandboxes.get(normalizedSandboxId);

      if (cached) {
        await cached.kill({ requestTimeoutMs: destroyOptions?.timeoutMs });
        sandboxes.delete(normalizedSandboxId);
        return;
      }

      const { Sandbox } = await loadSdk();
      await Sandbox.kill(normalizedSandboxId, {
        apiKey: readRequiredEnv(env, apiKeyEnvName),
        requestTimeoutMs: destroyOptions?.timeoutMs,
      });
    },
  };

  async function getSandbox(sandboxId: string): Promise<E2BSdkSandbox> {
    const normalizedSandboxId = readSandboxId(sandboxId);
    const cached = sandboxes.get(normalizedSandboxId);
    if (cached) return cached;

    const { Sandbox } = await loadSdk();
    const connected = await Sandbox.connect(normalizedSandboxId, {
      apiKey: readRequiredEnv(env, apiKeyEnvName),
    });
    sandboxes.set(normalizedSandboxId, connected);
    return connected;
  }
}

export function serializeE2BCommand(command: readonly string[]): string {
  if (command.length === 0) {
    throw new Error("e2b command requires at least one argv segment");
  }

  return command.map(quoteShellArg).join(" ");
}

async function loadE2BSdk(): Promise<{ readonly Sandbox: E2BSdkSandboxConstructor }> {
  const sdk = await import("e2b");
  return { Sandbox: sdk.Sandbox as unknown as E2BSdkSandboxConstructor };
}

function createSandboxOptions(input: E2BSandboxCreateInput, apiKey: string): E2BSdkSandboxCreateOptions {
  const launchSpec = input.launchSpec;

  return {
    apiKey,
    envs: {
      ...launchSpec.environment.variables,
    },
    metadata: {
      agentPoolProjectId: launchSpec.session.projectId,
      agentPoolTaskId: launchSpec.session.taskId,
      agentPoolSessionId: launchSpec.session.sessionId,
    },
    requestTimeoutMs: launchSpec.sandbox.startupTimeoutMs,
    secure: true,
    allowInternetAccess: true,
  };
}

function readSandboxTemplate(input: E2BSandboxCreateInput): string {
  const template = input.launchSpec.sandbox.templateId ?? input.launchSpec.sandbox.sandboxImageId;
  if (!template?.trim()) {
    throw new Error("e2b sdk client requires E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID");
  }

  return template.trim();
}

function normalizeCommandResult(
  result: E2BSdkCommandResult,
  stdoutChunks: readonly string[],
  stderrChunks: readonly string[],
): E2BCommandResult {
  const stdout = firstNonEmptyString(result.stdout, stdoutChunks.join(""));
  const stderr = firstNonEmptyString(result.stderr, result.error, stderrChunks.join(""));
  const exitCode = typeof result.exitCode === "number" ? result.exitCode : undefined;

  return {
    ok: exitCode === 0,
    ...(exitCode === undefined ? {} : { exitCode }),
    ...(stdout ? { stdout } : {}),
    ...(stderr ? { stderr } : {}),
  };
}

function readCommandFailure(error: unknown): E2BSdkCommandResult | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Readonly<Record<string, unknown>>;
  const exitCode = record.exitCode;

  if (typeof exitCode !== "number") return null;

  return {
    exitCode,
    stdout: typeof record.stdout === "string" ? record.stdout : undefined,
    stderr: typeof record.stderr === "string" ? record.stderr : undefined,
    error: typeof record.error === "string" ? record.error : error instanceof Error ? error.message : undefined,
  };
}

function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("e2b command argv segment must not contain NUL bytes");
  }
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}

function readRequiredEnv(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`${name} is required to create E2B sandboxes`);
  }

  return value;
}

function sanitizeEnvName(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Z_][A-Z0-9_]*$/.test(trimmed)) return trimmed;
  throw new Error("E2B API key env name is invalid");
}

function readSandboxId(sandboxId: string): string {
  const trimmed = sandboxId.trim();
  if (!trimmed) {
    throw new Error("e2b sdk client requires sandbox id");
  }

  return trimmed;
}

function firstNonEmptyString(...values: readonly (string | undefined)[]): string {
  return values.find((value) => value !== undefined && value.trim().length > 0)?.trim() ?? "";
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}
