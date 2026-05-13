import { bridgeSessionFromSandboxEnv, redactSandboxBridgeStartupEnv, createSandboxBridgeStartupEnv } from "./sandbox-startup";

if (import.meta.main) {
  const env = readProcessEnv();
  const session = bridgeSessionFromSandboxEnv(env);
  const startupEnv = createSandboxBridgeStartupEnv(session, session.workspaceRoot ?? env.AGENT_POOL_WORKSPACE_ROOT ?? "");

  if (process.argv.includes("--dry-run")) {
    process.stdout.write(`${JSON.stringify({ ok: true, session: redactSandboxBridgeStartupEnv(startupEnv) }, null, 2)}\n`);
  }
}

function readProcessEnv(): Readonly<Record<string, string | undefined>> {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: Readonly<Record<string, string | undefined>>;
    };
  };

  return processLike.process?.env ?? {};
}
