import { Template, defaultBuildLogger } from "e2b";

import { loadLocalEnv, readProcessEnv, type EnvSource } from "../local-env";
import { AGENT_POOL_E2B_TEMPLATE_NAME, agentPoolE2BTemplate } from "./template";

export type E2BTemplateBuildPlan = {
  readonly name: string;
  readonly cpuCount: number;
  readonly memoryMB: number;
  readonly apiKeyConfigured: boolean;
  readonly dryRun: boolean;
};

if (import.meta.main) {
  await main(Bun.argv.slice(2));
}

export async function main(args: readonly string[], env?: EnvSource): Promise<void> {
  const resolvedEnv = env ?? await loadLocalEnv();
  const plan = createE2BTemplateBuildPlan(args, resolvedEnv);

  if (plan.dryRun) {
    process.stdout.write(`${JSON.stringify({ ok: true, ...plan }, null, 2)}\n`);
    return;
  }

  const apiKey = resolvedEnv.E2B_API_KEY?.trim();
  if (!apiKey) {
    throw new Error("E2B_API_KEY is required to build the Agent Pool E2B template");
  }

  const buildInfo = await Template.build(agentPoolE2BTemplate, plan.name, {
    cpuCount: plan.cpuCount,
    memoryMB: plan.memoryMB,
    apiKey,
    onBuildLogs: defaultBuildLogger(),
  });

  process.stdout.write(
    `${JSON.stringify(
      {
        ok: true,
        name: buildInfo.name,
        templateId: buildInfo.templateId,
        buildId: buildInfo.buildId,
      },
      null,
      2,
    )}\n`,
  );
}

export function createE2BTemplateBuildPlan(args: readonly string[], env: EnvSource = readProcessEnv()): E2BTemplateBuildPlan {
  let name = env.E2B_TEMPLATE_NAME?.trim() || AGENT_POOL_E2B_TEMPLATE_NAME;
  let cpuCount = readPositiveInteger(env.E2B_TEMPLATE_CPU_COUNT, 1, "E2B_TEMPLATE_CPU_COUNT");
  let memoryMB = readPositiveInteger(env.E2B_TEMPLATE_MEMORY_MB, 1024, "E2B_TEMPLATE_MEMORY_MB");
  let dryRun = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    switch (arg) {
      case "--name":
        name = readFlag(args, (index += 1), arg);
        break;
      case "--cpu-count":
        cpuCount = readPositiveInteger(readFlag(args, (index += 1), arg), 1, arg);
        break;
      case "--memory-mb":
        memoryMB = readPositiveInteger(readFlag(args, (index += 1), arg), 1024, arg);
        break;
      case "--dry-run":
      case "--plan":
        dryRun = true;
        break;
      default:
        throw new Error(`unknown e2b template build argument: ${arg}`);
    }
  }

  return {
    name,
    cpuCount,
    memoryMB,
    apiKeyConfigured: Boolean(env.E2B_API_KEY?.trim()),
    dryRun,
  };
}

function readFlag(args: readonly string[], index: number, flag: string): string {
  const value = args[index]?.trim();
  if (!value) throw new Error(`${flag} requires a value`);
  return value;
}

function readPositiveInteger(value: string | undefined, fallback: number, name: string): number {
  const raw = value?.trim();
  if (!raw) return fallback;
  if (!/^\d+$/.test(raw)) throw new Error(`${name} must be a positive integer`);
  const parsed = Number(raw);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}
