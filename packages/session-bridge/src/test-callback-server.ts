import type {
  BridgeCallbackEvent,
  BridgeSessionToken,
  BridgeSteeringMessage,
} from "./index";

export type TestBridgeCallbackServerOptions = {
  readonly sessionToken: BridgeSessionToken;
  readonly steeringMessages?: readonly BridgeSteeringMessage[];
};

export type TestBridgeCallbackServer = {
  readonly fetch: typeof fetch;
  readonly events: readonly BridgeCallbackEvent[];
  readonly steeringPolls: readonly unknown[];
};

export function createTestBridgeCallbackServer(options: TestBridgeCallbackServerOptions): TestBridgeCallbackServer {
  const events: BridgeCallbackEvent[] = [];
  const steeringPolls: unknown[] = [];

  return {
    get events(): readonly BridgeCallbackEvent[] {
      return [...events];
    },
    get steeringPolls(): readonly unknown[] {
      return [...steeringPolls];
    },
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const auth = verifySessionToken(request, options.sessionToken);

      if (!auth.ok) {
        return Response.json(
          { ok: false, error: "invalid_session_token", reason: auth.reason },
          { status: auth.reason === "missing" ? 401 : 403 },
        );
      }

      if (request.method !== "POST") {
        return Response.json({ ok: false, error: "method_not_allowed" }, { status: 405 });
      }

      const url = new URL(request.url);
      const body = await request.json().catch(() => null);

      if (url.pathname === "/steering/poll") {
        steeringPolls.push(body);
        return Response.json({ ok: true, messages: options.steeringMessages ?? [] });
      }

      if (url.pathname.startsWith("/callbacks/")) {
        if (!isBridgeCallbackEvent(body)) {
          return Response.json({ ok: false, error: "invalid_callback_event" }, { status: 400 });
        }

        events.push(body);
        return Response.json({ ok: true, accepted: true, kind: body.kind });
      }

      return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    },
  };
}

function verifySessionToken(
  request: Request,
  expected: BridgeSessionToken,
): { readonly ok: true } | { readonly ok: false; readonly reason: "missing" | "invalid" } {
  const value = request.headers.get(expected.headerName);

  if (!value) return { ok: false, reason: "missing" };
  if (value !== expected.token) return { ok: false, reason: "invalid" };
  return { ok: true };
}

function isBridgeCallbackEvent(value: unknown): value is BridgeCallbackEvent {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { readonly kind?: unknown }).kind;

  return kind === "heartbeat" || kind === "output" || kind === "document" || kind === "final_response";
}
