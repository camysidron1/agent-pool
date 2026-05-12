import type {
  BridgeCallbackClient,
  BridgeCallbackResult,
  BridgeCleanupPayload,
  BridgeClock,
  BridgeCompletionPayload,
  BridgeEventBuffer,
  BridgeFailurePayload,
  BridgeSessionOptions,
} from "./index";

export type BridgeCompletionCaptureInput = {
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type BridgeFailureCaptureInput = {
  readonly errorMessage: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type BridgeCleanupCaptureInput = {
  readonly reason?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type BridgeLifecycleCaptureResult =
  | {
      readonly event: BridgeCompletionPayload;
      readonly callback: BridgeCallbackResult;
    }
  | {
      readonly event: BridgeFailurePayload;
      readonly callback: BridgeCallbackResult;
    }
  | {
      readonly event: BridgeCleanupPayload;
      readonly callback: BridgeCallbackResult;
    };

export type BridgeLifecycleCaptureOptions = {
  readonly session: BridgeSessionOptions;
  readonly client: Pick<BridgeCallbackClient, "postEvent">;
  readonly clock?: BridgeClock;
  readonly eventBuffer?: Pick<BridgeEventBuffer, "enqueue">;
};

export type BridgeLifecycleCapture = {
  readonly captureCompletion: (input?: BridgeCompletionCaptureInput) => Promise<BridgeLifecycleCaptureResult>;
  readonly captureFailure: (input: BridgeFailureCaptureInput) => Promise<BridgeLifecycleCaptureResult>;
  readonly captureCleanup: (input?: BridgeCleanupCaptureInput) => Promise<BridgeLifecycleCaptureResult>;
};

export function createBridgeLifecycleCapture(options: BridgeLifecycleCaptureOptions): BridgeLifecycleCapture {
  async function post(event: BridgeCompletionPayload | BridgeFailurePayload | BridgeCleanupPayload): Promise<BridgeLifecycleCaptureResult> {
    const callback = await options.client.postEvent(event);
    if (!callback.ok) {
      options.eventBuffer?.enqueue(event, callback.errorMessage);
    }

    return { event, callback } as BridgeLifecycleCaptureResult;
  }

  return {
    captureCompletion(input = {}) {
      return post({
        kind: "completion",
        ...sessionScope(options.session),
        observedAt: observedAt(options.clock),
        metadata: input.metadata,
      });
    },
    captureFailure(input) {
      return post({
        kind: "failure",
        ...sessionScope(options.session),
        errorMessage: input.errorMessage,
        observedAt: observedAt(options.clock),
        metadata: input.metadata,
      });
    },
    captureCleanup(input = {}) {
      return post({
        kind: "cleanup",
        ...sessionScope(options.session),
        reason: input.reason,
        observedAt: observedAt(options.clock),
        metadata: input.metadata,
      });
    },
  };
}

function sessionScope(session: BridgeSessionOptions): Pick<BridgeCompletionPayload, "projectId" | "taskId" | "sessionId"> {
  return {
    projectId: session.projectId,
    taskId: session.taskId,
    sessionId: session.sessionId,
  };
}

function observedAt(clock?: BridgeClock): string {
  return (clock?.now() ?? new Date()).toISOString();
}
