import type {
  BridgeCallbackEvent,
  BridgeClock,
  BridgeLogStreamKind,
  BridgeScheduler,
  BridgeSessionOptions,
} from "./index";
import { createBridgeCallbackClient } from "./callback-client";
import { discoverBridgeDocuments } from "./document-discovery";
import { createBridgeEventBuffer, type BridgeEventBuffer } from "./event-buffer";
import { createBridgeFinalResponseCapture } from "./final-response";
import { createBridgeHeartbeatLoop, type BridgeHeartbeatLoop } from "./heartbeat-loop";
import {
  createBridgeLifecycleCapture,
  type BridgeCleanupCaptureInput,
  type BridgeCompletionCaptureInput,
  type BridgeFailureCaptureInput,
} from "./lifecycle";
import { createBridgeMockHarness, type BridgeMockHarness } from "./mock-harness";
import { createBridgeOutputCapture } from "./output-capture";
import { createBridgeSteeringPoller } from "./steering-poller";

export type BridgeRunnerOutputInput = {
  readonly stream: BridgeLogStreamKind;
  readonly text: string;
};

export type BridgeRunnerRunOnceInput = {
  readonly output?: readonly BridgeRunnerOutputInput[];
  readonly finalResponseText?: string;
  readonly finalResponseMetadata?: Readonly<Record<string, unknown>>;
  readonly completion?: BridgeCompletionCaptureInput;
  readonly failure?: BridgeFailureCaptureInput;
  readonly cleanup?: BridgeCleanupCaptureInput;
};

export type BridgeRunnerOptions = {
  readonly session: BridgeSessionOptions;
  readonly fetch?: typeof fetch;
  readonly workspaceRoot?: string;
  readonly clock?: BridgeClock;
  readonly scheduler?: BridgeScheduler;
  readonly heartbeatIntervalMs?: number;
  readonly eventBuffer?: BridgeEventBuffer;
  readonly harness?: BridgeMockHarness;
};

export type BridgeRunnerRunOnceResult = {
  readonly heartbeatPosted: boolean;
  readonly outputPosted: number;
  readonly documentsDiscovered: number;
  readonly documentsPosted: number;
  readonly steeringFetched: number;
  readonly steeringHandled: number;
  readonly finalResponsePosted: boolean;
  readonly completionPosted: boolean;
  readonly failurePosted: boolean;
  readonly cleanupPosted: boolean;
  readonly bufferPending: number;
  readonly bufferDeadLetters: number;
};

export type BridgeRunner = {
  readonly running: boolean;
  readonly eventBuffer: BridgeEventBuffer;
  readonly harness: BridgeMockHarness;
  readonly heartbeatLoop: BridgeHeartbeatLoop;
  readonly runOnce: (input?: BridgeRunnerRunOnceInput) => Promise<BridgeRunnerRunOnceResult>;
  readonly start: () => void;
  readonly stop: () => void;
};

export function createBridgeRunner(options: BridgeRunnerOptions): BridgeRunner {
  const client = createBridgeCallbackClient({ session: options.session, fetch: options.fetch });
  const eventBuffer = options.eventBuffer ?? createBridgeEventBuffer({ clock: options.clock });
  const harness = options.harness ?? createBridgeMockHarness({ session: options.session, clock: options.clock });
  const heartbeatLoop = createBridgeHeartbeatLoop({
    session: options.session,
    client,
    intervalMs: options.heartbeatIntervalMs ?? 30_000,
    clock: options.clock,
    scheduler: options.scheduler,
    onFailure: ({ event, result }) => {
      if (!result.ok) eventBuffer.enqueue(event, result.errorMessage);
    },
  });
  const outputCapture = createBridgeOutputCapture({
    session: options.session,
    client,
    clock: options.clock,
    onFailure: ({ event, result }) => {
      if (!result.ok) eventBuffer.enqueue(event, result.errorMessage);
    },
  });
  const steeringPoller = createBridgeSteeringPoller({
    session: options.session,
    client,
    clock: options.clock,
    eventBuffer,
  });
  const finalResponseCapture = createBridgeFinalResponseCapture({
    session: options.session,
    client,
    clock: options.clock,
    eventBuffer,
  });
  const lifecycleCapture = createBridgeLifecycleCapture({
    session: options.session,
    client,
    clock: options.clock,
    eventBuffer,
  });

  return {
    get running(): boolean {
      return heartbeatLoop.running;
    },
    eventBuffer,
    harness,
    heartbeatLoop,
    async runOnce(input: BridgeRunnerRunOnceInput = {}): Promise<BridgeRunnerRunOnceResult> {
      const heartbeat = await heartbeatLoop.tick();
      let outputPosted = 0;
      let documentsPosted = 0;
      let steeringHandled = 0;
      let finalResponsePosted = false;
      let completionPosted = false;
      let failurePosted = false;
      let cleanupPosted = false;

      for (const output of input.output ?? [{ stream: "system", text: "bridge runner started" }]) {
        const result = await outputCapture.capture(output.stream, output.text);
        if (result.ok) outputPosted += 1;
      }

      const documents = options.workspaceRoot
        ? await discoverBridgeDocuments({ session: options.session, workspaceRoot: options.workspaceRoot })
        : [];
      for (const document of documents) {
        if (await postOrBuffer(client, eventBuffer, document)) {
          documentsPosted += 1;
        }
      }

      const steering = await steeringPoller.pollOnce();
      if (steering.ok) {
        for (const message of steeringPoller.drainHeld()) {
          const result = await harness.handleCommand({
            kind: message.confirmedInterrupt ? "interrupt" : "steering",
            message,
          });
          for (const output of result.output ?? []) {
            await postOrBuffer(client, eventBuffer, output);
          }
          steeringHandled += 1;
        }
      }

      if (input.finalResponseText) {
        const result = await finalResponseCapture.capture({
          text: input.finalResponseText,
          metadata: input.finalResponseMetadata,
        });
        finalResponsePosted = result.callback?.ok ?? false;
      }

      if (input.completion) {
        const result = await lifecycleCapture.captureCompletion(input.completion);
        completionPosted = result.callback.ok;
      }

      if (input.failure) {
        const result = await lifecycleCapture.captureFailure(input.failure);
        failurePosted = result.callback.ok;
      }

      if (input.cleanup) {
        const result = await lifecycleCapture.captureCleanup(input.cleanup);
        cleanupPosted = result.callback.ok;
      }

      return {
        heartbeatPosted: heartbeat.ok,
        outputPosted,
        documentsDiscovered: documents.length,
        documentsPosted,
        steeringFetched: steering.ok ? steering.fetched : 0,
        steeringHandled,
        finalResponsePosted,
        completionPosted,
        failurePosted,
        cleanupPosted,
        bufferPending: eventBuffer.pending.length,
        bufferDeadLetters: eventBuffer.deadLetters.length,
      };
    },
    start(): void {
      heartbeatLoop.start();
    },
    stop(): void {
      heartbeatLoop.stop();
    },
  };
}

async function postOrBuffer(
  client: ReturnType<typeof createBridgeCallbackClient>,
  eventBuffer: BridgeEventBuffer,
  event: BridgeCallbackEvent,
): Promise<boolean> {
  const result = await client.postEvent(event);
  if (result.ok) return true;

  eventBuffer.enqueue(event, result.errorMessage);
  return false;
}
