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
import type { BackendInternalApiClient, GitHubSessionTokenResponse } from "./backend-client";

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
  readonly githubTokenBroker?: Pick<BackendInternalApiClient, "mintGitHubSessionToken">;
  readonly requiresGitHubTokenBroker?: boolean;
};

export function createRuntimeStarter(options: RuntimeStarterOptions = {}): TaskRuntimeStarter {
  const provider =
    options.provider ??
    (options.providerKind === "e2b"
      ? createRuntimeProvider({ kind: "e2b", e2b: options.e2b })
      : options.providerKind && options.providerKind !== "fake"
        ? createRuntimeProvider({ kind: options.providerKind })
        : createRuntimeProvider({ kind: "fake", fake: options.fake }));

  return async (request) => startRuntimeSession(provider, request, options);
}

async function startRuntimeSession(
  provider: RuntimeProvider,
  request: TaskRuntimeStartupRequest,
  options: Pick<RuntimeStarterOptions, "workspaceRoot" | "githubTokenBroker" | "requiresGitHubTokenBroker">,
): Promise<TaskRuntimeStartupResult> {
  try {
    const taskId = readRequiredString(request.task, "id", "claimed task");
    const sessionId = readRequiredString(request.session, "id", "claimed session");
    const bridge = readBridgeSessionOptions(request.session, request.projectId, taskId, sessionId);
    const secretEnvironment = await readSecretEnvironment({
      projectId: request.projectId,
      sessionId,
      broker: options.githubTokenBroker,
      required: Boolean(options.requiresGitHubTokenBroker),
    });
    const handle = await provider.startSession({
      projectId: request.projectId,
      taskId,
      sessionId,
      task: request.task,
      session: request.session,
      sourceSnapshot: readSourceSnapshot(request.session),
      bridge,
      workspaceRoot: options.workspaceRoot ?? bridge.workspaceRoot,
      secretEnvironment,
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

async function readSecretEnvironment(input: {
  readonly projectId: string;
  readonly sessionId: string;
  readonly broker?: Pick<BackendInternalApiClient, "mintGitHubSessionToken">;
  readonly required: boolean;
}): Promise<Readonly<Record<string, string>> | undefined> {
  if (!input.required) return undefined;
  if (!input.broker) {
    throw new Error("GitHub App token broker is required for codex e2b runner");
  }

  const response = await input.broker.mintGitHubSessionToken({
    projectId: input.projectId,
    sessionId: input.sessionId,
  });

  if (!response.ok || !isGitHubSessionTokenResponse(response.body)) {
    throw new Error("GitHub App token broker failed to mint a session token");
  }

  return {
    [response.body.token.envName]: response.body.token.value,
  };
}

function isGitHubSessionTokenResponse(value: unknown): value is GitHubSessionTokenResponse {
  if (!value || typeof value !== "object") return false;
  const body = value as Readonly<Record<string, unknown>>;
  const token = body.token;
  if (body.ok !== true || !token || typeof token !== "object" || Array.isArray(token)) return false;
  const record = token as Readonly<Record<string, unknown>>;
  return typeof record.envName === "string" && typeof record.value === "string";
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

function readSourceSnapshot(session: Readonly<Record<string, unknown>>): { readonly id: string; readonly provider: string; readonly providerSnapshotId: string } | null {
  const snapshot = session.sourceSnapshot;
  if (!snapshot || typeof snapshot !== "object" || Array.isArray(snapshot)) return null;
  const record = snapshot as Readonly<Record<string, unknown>>;
  return {
    id: readRequiredString(record, "id", "claimed session source snapshot"),
    provider: readRequiredString(record, "provider", "claimed session source snapshot"),
    providerSnapshotId: readRequiredString(record, "providerSnapshotId", "claimed session source snapshot"),
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
