import {
  createRuntimeProvider,
  type E2BRuntimeClient,
  type E2BRuntimeProviderConfig,
  type FakeRuntimeProviderOptions,
  type RuntimeBridgeSessionOptions,
  type RuntimeProvider,
  type RuntimeProviderKind,
} from "@agent-pool/runtime";

import type { TaskRuntimeStarter, TaskRuntimeStartupRequest, TaskRuntimeStartupResult } from "./task-consumer";

export type RuntimeStarterOptions = {
  readonly provider?: RuntimeProvider;
  readonly providerKind?: RuntimeProviderKind;
  readonly e2b?: {
    readonly client?: E2BRuntimeClient;
    readonly config: E2BRuntimeProviderConfig;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly secretEnvNames?: readonly string[];
  };
  readonly fake?: FakeRuntimeProviderOptions;
  readonly workspaceRoot?: string;
};

export function createRuntimeStarter(options: RuntimeStarterOptions = {}): TaskRuntimeStarter {
  const provider =
    options.provider ??
    (options.providerKind === "e2b"
      ? createRuntimeProvider({ kind: "e2b", e2b: options.e2b })
      : options.providerKind && options.providerKind !== "fake"
        ? createRuntimeProvider({ kind: options.providerKind })
        : createRuntimeProvider({ kind: "fake", fake: options.fake }));

  return async (request) => startRuntimeSession(provider, request, options.workspaceRoot);
}

async function startRuntimeSession(
  provider: RuntimeProvider,
  request: TaskRuntimeStartupRequest,
  workspaceRoot?: string,
): Promise<TaskRuntimeStartupResult> {
  try {
    const taskId = readRequiredString(request.task, "id", "claimed task");
    const sessionId = readRequiredString(request.session, "id", "claimed session");
    const bridge = readBridgeSessionOptions(request.session, request.projectId, taskId, sessionId);
    const handle = await provider.startSession({
      projectId: request.projectId,
      taskId,
      sessionId,
      task: request.task,
      session: request.session,
      bridge,
      workspaceRoot: workspaceRoot ?? bridge.workspaceRoot,
    });

    return {
      ok: true,
      runtimeSessionId: handle.sessionId,
      ...(handle.afterStartup ? { afterStartup: handle.afterStartup } : {}),
    };
  } catch (error) {
    return { ok: false, errorMessage: error instanceof Error ? error.message : String(error) };
  }
}

function readBridgeSessionOptions(
  session: Readonly<Record<string, unknown>>,
  projectId: string,
  taskId: string,
  sessionId: string,
): RuntimeBridgeSessionOptions {
  const bridge = readRecord(session.bridge, "claimed session bridge config");
  const sessionToken = readRecord(bridge.sessionToken, "claimed session bridge token");

  return {
    projectId,
    taskId,
    sessionId,
    callbackBaseUrl: readRequiredString(bridge, "callbackBaseUrl", "claimed session bridge config"),
    sessionToken: {
      headerName: readRequiredString(sessionToken, "headerName", "claimed session bridge token"),
      token: readRequiredString(sessionToken, "token", "claimed session bridge token"),
    },
    workspaceRoot: readOptionalString(bridge.workspaceRoot),
  };
}

function readRecord(value: unknown, name: string): Readonly<Record<string, unknown>> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} is missing`);
  }

  return value as Readonly<Record<string, unknown>>;
}

function readRequiredString(record: Readonly<Record<string, unknown>>, key: string, name: string): string {
  const value = readOptionalString(record[key]);
  if (!value) throw new Error(`${name} is missing ${key}`);
  return value;
}

function readOptionalString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}
