import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

export type EnvSource = Readonly<Record<string, string | undefined>>;

export type LocalEnvLoadOptions = {
  readonly cwd?: string;
  readonly files?: readonly string[];
  readonly env?: EnvSource;
};

const DEFAULT_ENV_FILES = [".env"] as const;

export async function loadLocalEnv(options: LocalEnvLoadOptions = {}): Promise<EnvSource> {
  const cwd = options.cwd ?? process.cwd();
  const processEnv = options.env ?? readProcessEnv();
  const files = options.files ?? readEnvFileList(processEnv);
  const values: Record<string, string> = {};

  for (const file of files) {
    const path = resolve(cwd, file);
    if (!existsSync(path)) continue;
    Object.assign(values, parseLocalEnvFile(await readFile(path, "utf8")));
  }

  return mergeEnvSources(values, processEnv);
}

export function parseLocalEnvFile(text: string): Record<string, string> {
  const values: Record<string, string> = {};

  for (const rawLine of text.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;

    const line = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trimStart() : trimmed;
    const equalsIndex = line.indexOf("=");
    if (equalsIndex <= 0) {
      throw new Error("env file lines must use KEY=value syntax");
    }

    const key = line.slice(0, equalsIndex).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`invalid env file key: ${key}`);
    }

    values[key] = unquoteEnvValue(line.slice(equalsIndex + 1).trim());
  }

  return values;
}

export function readProcessEnv(): EnvSource {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: EnvSource;
    };
  };

  return processLike.process?.env ?? {};
}

function readEnvFileList(env: EnvSource): readonly string[] {
  const configured = env.AGENT_POOL_ENV_FILE?.trim();
  if (!configured) return DEFAULT_ENV_FILES;

  const files = configured.split(",").map((file) => file.trim()).filter(Boolean);
  return files.length > 0 ? files : DEFAULT_ENV_FILES;
}

function mergeEnvSources(fileValues: EnvSource, envValues: EnvSource): EnvSource {
  const merged: Record<string, string> = {};

  for (const [key, value] of Object.entries(fileValues)) {
    if (value !== undefined) merged[key] = value;
  }

  for (const [key, value] of Object.entries(envValues)) {
    if (value !== undefined) merged[key] = value;
  }

  return merged;
}

function unquoteEnvValue(rawValue: string): string {
  if (rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2) {
    return rawValue.slice(1, -1).replace(/\\([nrt"\\])/g, (_match, escaped: string) => {
      switch (escaped) {
        case "n":
          return "\n";
        case "r":
          return "\r";
        case "t":
          return "\t";
        default:
          return escaped;
      }
    });
  }

  if (rawValue.startsWith("'") && rawValue.endsWith("'") && rawValue.length >= 2) {
    return rawValue.slice(1, -1);
  }

  return rawValue.replace(/\s+#.*$/, "").trimEnd();
}
