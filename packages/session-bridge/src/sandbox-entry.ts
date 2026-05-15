import { bridgeSessionFromSandboxEnv, redactSandboxBridgeStartupEnv, createSandboxBridgeStartupEnv } from "./sandbox-startup";
import { createBridgeRunner, type BridgeRunnerRunOnceResult } from "./runner";
import { runCodexBridgeSession, type CodexBridgeSessionResult } from "./codex-runner";

export type SandboxBridgeEntryResult = {
  readonly ok: true;
  readonly dryRun: boolean;
  readonly session: ReturnType<typeof redactSandboxBridgeStartupEnv>;
  readonly firstPass?: BridgeRunnerRunOnceResult;
  readonly terminalPass?: BridgeRunnerRunOnceResult;
  readonly codexRun?: CodexBridgeSessionResult;
};

export type SandboxBridgeEntryOptions = {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly fetch?: typeof fetch;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly write?: (text: string) => void;
  readonly args?: readonly string[];
};

if (import.meta.main) {
  try {
    const result = await runSandboxBridgeEntry({ args: process.argv.slice(2) });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  }
}

export async function runSandboxBridgeEntry(options: SandboxBridgeEntryOptions = {}): Promise<SandboxBridgeEntryResult> {
  const env = options.env ?? readProcessEnv();
  const args = options.args ?? [];
  const session = bridgeSessionFromSandboxEnv(env);
  const workspaceRoot = session.workspaceRoot ?? env.AGENT_POOL_WORKSPACE_ROOT ?? "";
  const startupEnv = createSandboxBridgeStartupEnv(session, workspaceRoot);
  const redactedSession = redactSandboxBridgeStartupEnv(startupEnv);

  if (args.includes("--dry-run")) {
    return { ok: true, dryRun: true, session: redactedSession };
  }

  if (env.AGENT_POOL_BRIDGE_RUNNER === "codex") {
    const codexRun = await runCodexBridgeSession({
      session,
      workspaceRoot,
      env,
      fetch: options.fetch,
    });
    if (!codexRun.terminalPass.failurePosted && !codexRun.terminalPass.completionPosted) {
      throw new Error("codex bridge terminal callbacks were not accepted");
    }
    return {
      ok: true,
      dryRun: false,
      session: redactedSession,
      firstPass: codexRun.firstPass,
      terminalPass: codexRun.terminalPass,
      codexRun,
    };
  }

  const runner = createBridgeRunner({
    session,
    workspaceRoot,
    fetch: options.fetch,
  });
  const firstPass = await runner.runOnce({
    output: [
      {
        stream: "system",
        text: `sandbox bridge accepted session ${session.sessionId} for task ${session.taskId}`,
      },
    ],
  });

  await (options.sleep ?? sleep)(readCompletionDelayMs(env.AGENT_POOL_BRIDGE_COMPLETION_DELAY_MS));

  const terminalPass = await runner.runOnce({
    output: [],
    finalResponseText: `Sandbox bridge completed task ${session.taskId} from ${workspaceRoot}.`,
    finalResponseMetadata: {
      provider: "e2b",
      mode: "sandbox-smoke",
    },
    completion: {
      metadata: {
        provider: "e2b",
        mode: "sandbox-smoke",
      },
    },
    cleanup: {
      reason: "sandbox bridge completed",
      metadata: {
        provider: "e2b",
        mode: "sandbox-smoke",
      },
    },
  });

  if (!terminalPass.finalResponsePosted || !terminalPass.completionPosted || !terminalPass.cleanupPosted) {
    throw new Error("sandbox bridge terminal callbacks were not accepted");
  }

  return { ok: true, dryRun: false, session: redactedSession, firstPass, terminalPass };
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}

function readCompletionDelayMs(value: string | undefined): number {
  const parsed = Number(value?.trim() || "5000");
  if (Number.isInteger(parsed) && parsed >= 0 && parsed <= 60_000) return parsed;
  throw new Error("AGENT_POOL_BRIDGE_COMPLETION_DELAY_MS must be an integer between 0 and 60000");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}
