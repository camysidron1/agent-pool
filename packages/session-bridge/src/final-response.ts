import type {
  BridgeCallbackClient,
  BridgeCallbackResult,
  BridgeClock,
  BridgeEventBuffer,
  BridgeFinalResponsePayload,
  BridgeSessionOptions,
} from "./index";

export type BridgeTranscriptMessage = {
  readonly role: "user" | "assistant" | "system" | "tool";
  readonly content: string;
  readonly final?: boolean;
};

export type BridgeFinalResponseCaptureInput = {
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type BridgeFinalResponseCaptureResult = {
  readonly event: BridgeFinalResponsePayload;
  readonly idempotent: boolean;
  readonly callback: BridgeCallbackResult | null;
};

export type BridgeFinalResponseCaptureOptions = {
  readonly session: BridgeSessionOptions;
  readonly client: Pick<BridgeCallbackClient, "postEvent">;
  readonly clock?: BridgeClock;
  readonly eventBuffer?: Pick<BridgeEventBuffer, "enqueue">;
};

export type BridgeFinalResponseCapture = {
  readonly capture: (input: BridgeFinalResponseCaptureInput) => Promise<BridgeFinalResponseCaptureResult>;
  readonly captureFromTranscript: (
    messages: readonly BridgeTranscriptMessage[],
    metadata?: Readonly<Record<string, unknown>>,
  ) => Promise<BridgeFinalResponseCaptureResult | null>;
};

export function createBridgeFinalResponseCapture(
  options: BridgeFinalResponseCaptureOptions,
): BridgeFinalResponseCapture {
  let lastSignature: string | null = null;
  let lastEvent: BridgeFinalResponsePayload | null = null;

  async function capture(input: BridgeFinalResponseCaptureInput): Promise<BridgeFinalResponseCaptureResult> {
    const signature = JSON.stringify({ text: input.text, metadata: input.metadata ?? {} });
    if (signature === lastSignature && lastEvent) {
      return {
        event: lastEvent,
        idempotent: true,
        callback: null,
      };
    }

    const event = finalResponseEvent(options.session, input, options.clock?.now() ?? new Date());
    lastSignature = signature;
    lastEvent = event;

    const callback = await options.client.postEvent(event);
    if (!callback.ok) {
      options.eventBuffer?.enqueue(event, callback.errorMessage);
    }

    return {
      event,
      idempotent: false,
      callback,
    };
  }

  return {
    capture,
    captureFromTranscript(messages, metadata) {
      const final = [...messages].reverse().find((message) => message.role === "assistant" && (message.final ?? true));

      if (!final) return Promise.resolve(null);
      return capture({ text: final.content, metadata });
    },
  };
}

export function extractFinalResponseUrls(text: string): readonly string[] {
  const matches = text.match(/https?:\/\/[^\s<>"')\]]+/g) ?? [];
  return Array.from(new Set(matches.map((value) => value.replace(/[.,;:!?]+$/, ""))));
}

function finalResponseEvent(
  session: BridgeSessionOptions,
  input: BridgeFinalResponseCaptureInput,
  observedAt: Date,
): BridgeFinalResponsePayload {
  return {
    kind: "final_response",
    projectId: session.projectId,
    taskId: session.taskId,
    sessionId: session.sessionId,
    text: input.text,
    metadata: input.metadata,
    urlCandidates: extractFinalResponseUrls(input.text),
    observedAt: observedAt.toISOString(),
  };
}
