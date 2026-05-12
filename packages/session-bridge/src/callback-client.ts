import type {
  BridgeCallbackClient,
  BridgeCallbackEvent,
  BridgeCallbackResult,
  BridgeSessionOptions,
  BridgeSteeringPollResult,
} from "./index";

export type BridgeCallbackClientOptions = {
  readonly session: BridgeSessionOptions;
  readonly fetch?: typeof fetch;
};

export function createBridgeCallbackClient(options: BridgeCallbackClientOptions): BridgeCallbackClient {
  const fetchImpl = options.fetch ?? fetch;

  return {
    postEvent: (event) => postJson(fetchImpl, options.session, `/callbacks/${event.kind}`, event),
    async pollSteering(): Promise<BridgeSteeringPollResult> {
      const result = await postJson(fetchImpl, options.session, "/steering/poll", bridgeSessionBody(options.session));

      if (!result.ok) {
        return {
          ok: false,
          status: result.status,
          errorMessage: result.errorMessage,
        };
      }

      const body = result.body as { readonly messages?: unknown };
      const messages = Array.isArray(body.messages) ? body.messages : [];

      return {
        ok: true,
        messages: messages.filter(isSteeringMessage),
      };
    },
  };
}

async function postJson(
  fetchImpl: typeof fetch,
  session: BridgeSessionOptions,
  path: string,
  body: BridgeCallbackEvent | Readonly<Record<string, unknown>>,
): Promise<BridgeCallbackResult> {
  const response = await fetchImpl(`${session.callbackBaseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      [session.sessionToken.headerName]: session.sessionToken.token,
    },
    body: JSON.stringify(body),
  });
  const responseBody = await response.json().catch(() => null);
  const ok = response.status >= 200 && response.status < 300;

  if (ok) {
    return { ok: true, status: response.status, body: responseBody };
  }

  return {
    ok: false,
    status: response.status,
    body: responseBody,
    errorMessage: readErrorMessage(responseBody) ?? `callback request failed with status ${response.status}`,
  };
}

function bridgeSessionBody(session: BridgeSessionOptions): Readonly<Record<string, unknown>> {
  return {
    projectId: session.projectId,
    taskId: session.taskId,
    sessionId: session.sessionId,
  };
}

function readErrorMessage(body: unknown): string | undefined {
  if (!body || typeof body !== "object") return undefined;
  const value = (body as { readonly error?: unknown; readonly message?: unknown }).message ?? (body as { readonly error?: unknown }).error;

  return typeof value === "string" ? value : undefined;
}

function isSteeringMessage(value: unknown): value is BridgeSteeringPollResult extends { readonly messages: readonly (infer T)[] } ? T : never {
  if (!value || typeof value !== "object") return false;
  const candidate = value as { readonly id?: unknown; readonly body?: unknown };

  return typeof candidate.id === "string" && typeof candidate.body === "string";
}
