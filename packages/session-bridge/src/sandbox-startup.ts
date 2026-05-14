import type { BridgeSessionOptions } from "./index";

export const SANDBOX_BRIDGE_ENTRYPOINT = "packages/session-bridge/src/sandbox-entry.ts" as const;

export type SandboxBridgeStartupEnv = {
  readonly AGENT_POOL_PROJECT_ID: string;
  readonly AGENT_POOL_TASK_ID: string;
  readonly AGENT_POOL_SESSION_ID: string;
  readonly AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: string;
  readonly AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: string;
  readonly AGENT_POOL_BRIDGE_SESSION_TOKEN: string;
  readonly AGENT_POOL_WORKSPACE_ROOT: string;
};

export type SandboxBridgeStartupCommand = {
  readonly command: readonly string[];
  readonly env: SandboxBridgeStartupEnv;
};

export function createSandboxBridgeStartupEnv(session: BridgeSessionOptions, workspaceRoot: string): SandboxBridgeStartupEnv {
  const projectId = required(session.projectId, "projectId");
  const taskId = required(session.taskId, "taskId");
  const sessionId = required(session.sessionId, "sessionId");
  const callbackBaseUrl = required(session.callbackBaseUrl, "callbackBaseUrl");
  const headerName = required(session.sessionToken.headerName, "sessionToken.headerName").toLowerCase();
  const token = required(session.sessionToken.token, "sessionToken.token");
  const root = required(workspaceRoot, "workspaceRoot");

  return {
    AGENT_POOL_PROJECT_ID: projectId,
    AGENT_POOL_TASK_ID: taskId,
    AGENT_POOL_SESSION_ID: sessionId,
    AGENT_POOL_BRIDGE_CALLBACK_BASE_URL: callbackBaseUrl,
    AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER: headerName,
    AGENT_POOL_BRIDGE_SESSION_TOKEN: token,
    AGENT_POOL_WORKSPACE_ROOT: root,
  };
}

export function buildSandboxBridgeStartupCommand(input: {
  readonly session: BridgeSessionOptions;
  readonly workspaceRoot: string;
  readonly entrypoint?: string;
}): SandboxBridgeStartupCommand {
  const entrypoint = input.entrypoint?.trim() || SANDBOX_BRIDGE_ENTRYPOINT;
  const workspaceRoot = required(input.workspaceRoot, "workspaceRoot");

  return {
    command: ["sh", "-lc", `nohup bun run ${quoteShellArg(resolveSandboxEntrypoint(entrypoint, workspaceRoot))} > /tmp/agent-pool-session-bridge.log 2>&1 &`],
    env: createSandboxBridgeStartupEnv(input.session, workspaceRoot),
  };
}

export function redactSandboxBridgeStartupEnv(env: SandboxBridgeStartupEnv): SandboxBridgeStartupEnv {
  return {
    ...env,
    AGENT_POOL_BRIDGE_SESSION_TOKEN: "[REDACTED]",
  };
}

export function bridgeSessionFromSandboxEnv(env: Readonly<Record<string, string | undefined>>): BridgeSessionOptions {
  return {
    projectId: required(env.AGENT_POOL_PROJECT_ID, "AGENT_POOL_PROJECT_ID"),
    taskId: required(env.AGENT_POOL_TASK_ID, "AGENT_POOL_TASK_ID"),
    sessionId: required(env.AGENT_POOL_SESSION_ID, "AGENT_POOL_SESSION_ID"),
    callbackBaseUrl: required(env.AGENT_POOL_BRIDGE_CALLBACK_BASE_URL, "AGENT_POOL_BRIDGE_CALLBACK_BASE_URL"),
    sessionToken: {
      headerName: required(env.AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER, "AGENT_POOL_BRIDGE_SESSION_TOKEN_HEADER").toLowerCase(),
      token: required(env.AGENT_POOL_BRIDGE_SESSION_TOKEN, "AGENT_POOL_BRIDGE_SESSION_TOKEN"),
    },
    workspaceRoot: required(env.AGENT_POOL_WORKSPACE_ROOT, "AGENT_POOL_WORKSPACE_ROOT"),
  };
}

function required(value: string | undefined, name: string): string {
  const trimmed = value?.trim();
  if (!trimmed) throw new Error(`sandbox bridge startup requires ${name}`);
  return trimmed;
}

function resolveSandboxEntrypoint(entrypoint: string, workspaceRoot: string): string {
  if (entrypoint.includes("\0") || entrypoint.includes("~") || entrypoint.includes("..")) {
    throw new Error("sandbox bridge startup entrypoint is invalid");
  }
  if (entrypoint.startsWith("/")) return entrypoint;

  return `${workspaceRoot.replace(/\/+$/, "")}/${entrypoint.replace(/^\/+/, "")}`;
}

function quoteShellArg(value: string): string {
  if (value.includes("\0")) {
    throw new Error("sandbox bridge startup entrypoint is invalid");
  }

  return `'${value.replaceAll("'", "'\\''")}'`;
}
