export type BridgeSessionToken = {
  readonly headerName: string;
  readonly token: string;
};

export type BridgeSessionOptions = {
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly callbackBaseUrl: string;
  readonly sessionToken: BridgeSessionToken;
  readonly workspaceRoot?: string;
};

export type BridgeLogStreamKind = "stdout" | "stderr" | "combined" | "system";

export type BridgeHeartbeatPayload = {
  readonly kind: "heartbeat";
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly observedAt: string;
};

export type BridgeOutputChunk = {
  readonly kind: "output";
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly stream: BridgeLogStreamKind;
  readonly sequence: number;
  readonly byteOffset: number;
  readonly text: string;
  readonly observedAt: string;
};

export type BridgeDocumentRegistration = {
  readonly kind: "document";
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly path: string;
  readonly title: string;
  readonly contentType?: string;
  readonly sizeBytes?: number;
};

export type BridgeFinalResponsePayload = {
  readonly kind: "final_response";
  readonly projectId: string;
  readonly taskId: string;
  readonly sessionId: string;
  readonly text: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
  readonly urlCandidates: readonly string[];
  readonly observedAt: string;
};

export type BridgeCallbackEvent =
  | BridgeHeartbeatPayload
  | BridgeOutputChunk
  | BridgeDocumentRegistration
  | BridgeFinalResponsePayload;

export type BridgeCallbackResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly body: unknown; readonly errorMessage: string };

export type BridgeCallbackClient = {
  readonly postEvent: (event: BridgeCallbackEvent) => Promise<BridgeCallbackResult>;
  readonly pollSteering: () => Promise<BridgeSteeringPollResult>;
};

export type BridgeScheduler = {
  readonly setInterval: (callback: () => void | Promise<unknown>, intervalMs: number) => unknown;
  readonly clearInterval: (handle: unknown) => void;
};

export type BridgeClock = {
  readonly now: () => Date;
};

export type BridgeSteeringMessage = {
  readonly id: string;
  readonly body: string;
  readonly commandId?: string;
  readonly confirmedInterrupt?: boolean;
  readonly metadata?: Readonly<Record<string, unknown>>;
};

export type BridgeSteeringPollResult =
  | { readonly ok: true; readonly messages: readonly BridgeSteeringMessage[] }
  | { readonly ok: false; readonly status: number; readonly errorMessage: string };

export type BridgeHarnessCommand =
  | { readonly kind: "steering"; readonly message: BridgeSteeringMessage }
  | { readonly kind: "interrupt"; readonly message: BridgeSteeringMessage }
  | { readonly kind: "restart"; readonly reason: string };

export type BridgeHarnessResult =
  | { readonly ok: true; readonly output?: readonly BridgeOutputChunk[] }
  | { readonly ok: false; readonly errorMessage: string; readonly output?: readonly BridgeOutputChunk[] };

export type BridgeHarness = {
  readonly handleCommand: (command: BridgeHarnessCommand) => BridgeHarnessResult | Promise<BridgeHarnessResult>;
};

export type BridgeEventBufferRecord = {
  readonly id: string;
  readonly event: BridgeCallbackEvent;
  readonly attempts: number;
  readonly lastError?: string;
  readonly deadLetteredAt?: string;
};

export const SESSION_BRIDGE_PACKAGE_BOUNDARY = {
  bridgeOnly: true,
  importsBackendDb: false,
  importsWebUi: false,
  importsRuntimeProvider: false,
  includesRealProvider: false,
} as const;

export {
  createBridgeCallbackClient,
  type BridgeCallbackClientOptions,
} from "./callback-client";
export {
  discoverBridgeDocuments,
  type BridgeDocumentDiscoveryOptions,
} from "./document-discovery";
export {
  createBridgeEventBuffer,
  type BridgeEventBuffer,
  type BridgeEventBufferFlushResult,
  type BridgeEventBufferOptions,
  type BridgeEventDeadLetterRecord,
} from "./event-buffer";
export {
  createBridgeFinalResponseCapture,
  extractFinalResponseUrls,
  type BridgeFinalResponseCapture,
  type BridgeFinalResponseCaptureInput,
  type BridgeFinalResponseCaptureOptions,
  type BridgeFinalResponseCaptureResult,
  type BridgeTranscriptMessage,
} from "./final-response";
export {
  createBridgeHeartbeatLoop,
  type BridgeHeartbeatFailure,
  type BridgeHeartbeatLoop,
  type BridgeHeartbeatLoopOptions,
} from "./heartbeat-loop";
export {
  createBridgeMockHarness,
  type BridgeMockHarness,
  type BridgeMockHarnessOptions,
  type BridgeMockHarnessState,
} from "./mock-harness";
export {
  createBridgeOutputCapture,
  type BridgeOutputCapture,
  type BridgeOutputCaptureOptions,
  type BridgeOutputFailure,
} from "./output-capture";
export {
  createBridgeSteeringPoller,
  type BridgeSteeringPoller,
  type BridgeSteeringPollerOptions,
  type BridgeSteeringPollOnceResult,
} from "./steering-poller";
export {
  createTestBridgeCallbackServer,
  type TestBridgeCallbackServer,
  type TestBridgeCallbackServerOptions,
} from "./test-callback-server";
