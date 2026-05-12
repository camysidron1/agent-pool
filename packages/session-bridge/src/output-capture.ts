import type {
  BridgeCallbackClient,
  BridgeCallbackResult,
  BridgeClock,
  BridgeLogStreamKind,
  BridgeOutputChunk,
  BridgeSessionOptions,
} from "./index";

export type BridgeOutputFailure = {
  readonly event: BridgeOutputChunk;
  readonly result: BridgeCallbackResult;
};

export type BridgeOutputCaptureOptions = {
  readonly session: BridgeSessionOptions;
  readonly client: Pick<BridgeCallbackClient, "postEvent">;
  readonly clock?: BridgeClock;
  readonly onFailure?: (failure: BridgeOutputFailure) => void | Promise<void>;
};

export type BridgeOutputCapture = {
  readonly nextSequence: number;
  readonly byteOffset: number;
  readonly capture: (stream: BridgeLogStreamKind, text: string) => Promise<BridgeCallbackResult>;
};

export function createBridgeOutputCapture(options: BridgeOutputCaptureOptions): BridgeOutputCapture {
  let nextSequence = 1;
  let byteOffset = 0;

  return {
    get nextSequence(): number {
      return nextSequence;
    },
    get byteOffset(): number {
      return byteOffset;
    },
    async capture(stream, text): Promise<BridgeCallbackResult> {
      const event: BridgeOutputChunk = {
        kind: "output",
        projectId: options.session.projectId,
        taskId: options.session.taskId,
        sessionId: options.session.sessionId,
        stream,
        sequence: nextSequence,
        byteOffset,
        text,
        observedAt: (options.clock?.now() ?? new Date()).toISOString(),
      };

      nextSequence += 1;
      byteOffset += byteLength(text);

      const result = await options.client.postEvent(event);
      if (!result.ok) {
        await options.onFailure?.({ event, result });
      }

      return result;
    },
  };
}

function byteLength(value: string): number {
  return new TextEncoder().encode(value).byteLength;
}
