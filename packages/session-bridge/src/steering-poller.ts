import type {
  BridgeCallbackClient,
  BridgeClock,
  BridgeEventBuffer,
  BridgeSessionOptions,
  BridgeSteeringMessage,
} from "./index";

export type BridgeSteeringPollerOptions = {
  readonly session: BridgeSessionOptions;
  readonly client: Pick<BridgeCallbackClient, "pollSteering">;
  readonly clock?: BridgeClock;
  readonly eventBuffer?: Pick<BridgeEventBuffer, "enqueue">;
};

export type BridgeSteeringPollOnceResult =
  | {
      readonly ok: true;
      readonly fetched: number;
      readonly held: readonly BridgeSteeringMessage[];
      readonly noWork: boolean;
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly errorMessage: string;
      readonly held: readonly BridgeSteeringMessage[];
    };

export type BridgeSteeringPoller = {
  readonly heldMessages: readonly BridgeSteeringMessage[];
  readonly pollOnce: () => Promise<BridgeSteeringPollOnceResult>;
  readonly drainHeld: () => readonly BridgeSteeringMessage[];
};

export function createBridgeSteeringPoller(options: BridgeSteeringPollerOptions): BridgeSteeringPoller {
  let heldMessages: BridgeSteeringMessage[] = [];

  return {
    get heldMessages(): readonly BridgeSteeringMessage[] {
      return [...heldMessages];
    },
    async pollOnce(): Promise<BridgeSteeringPollOnceResult> {
      const result = await options.client.pollSteering();

      if (!result.ok) {
        options.eventBuffer?.enqueue(
          {
            kind: "output",
            projectId: options.session.projectId,
            taskId: options.session.taskId,
            sessionId: options.session.sessionId,
            stream: "system",
            sequence: 0,
            byteOffset: 0,
            text: `steering poll failed: ${result.errorMessage}`,
            observedAt: (options.clock?.now() ?? new Date()).toISOString(),
          },
          result.errorMessage,
        );

        return {
          ok: false,
          status: result.status,
          errorMessage: result.errorMessage,
          held: [...heldMessages],
        };
      }

      const known = new Set(heldMessages.map((message) => message.id));
      const fresh = result.messages.filter((message) => !known.has(message.id));
      heldMessages = [...heldMessages, ...fresh];

      return {
        ok: true,
        fetched: fresh.length,
        held: [...heldMessages],
        noWork: fresh.length === 0,
      };
    },
    drainHeld(): readonly BridgeSteeringMessage[] {
      const drained = heldMessages;
      heldMessages = [];
      return drained;
    },
  };
}
