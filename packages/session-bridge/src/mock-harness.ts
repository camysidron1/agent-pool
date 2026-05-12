import type {
  BridgeClock,
  BridgeHarness,
  BridgeHarnessCommand,
  BridgeHarnessResult,
  BridgeOutputChunk,
  BridgeSessionOptions,
  BridgeSteeringMessage,
} from "./index";

export type BridgeMockHarnessOptions = {
  readonly session: BridgeSessionOptions;
  readonly clock?: BridgeClock;
};

export type BridgeMockHarnessState = {
  readonly generation: number;
  readonly handledSteering: readonly BridgeSteeringMessage[];
  readonly restartCount: number;
};

export type BridgeMockHarness = BridgeHarness & {
  readonly state: BridgeMockHarnessState;
};

export function createBridgeMockHarness(options: BridgeMockHarnessOptions): BridgeMockHarness {
  let generation = 1;
  let restartCount = 0;
  let sequence = 1;
  let byteOffset = 0;
  let handledSteering: BridgeSteeringMessage[] = [];

  function systemOutput(text: string): BridgeOutputChunk {
    const chunk: BridgeOutputChunk = {
      kind: "output",
      projectId: options.session.projectId,
      taskId: options.session.taskId,
      sessionId: options.session.sessionId,
      stream: "system",
      sequence,
      byteOffset,
      text,
      observedAt: (options.clock?.now() ?? new Date()).toISOString(),
    };

    sequence += 1;
    byteOffset += new TextEncoder().encode(text).byteLength;
    return chunk;
  }

  return {
    get state(): BridgeMockHarnessState {
      return {
        generation,
        handledSteering: [...handledSteering],
        restartCount,
      };
    },
    handleCommand(command): BridgeHarnessResult {
      if (!isKnownCommand(command)) {
        return {
          ok: false,
          errorMessage: "unsupported mock harness command",
          output: [systemOutput("unsupported mock harness command")],
        };
      }

      switch (command.kind) {
        case "steering":
          handledSteering = [...handledSteering, command.message];
          return {
            ok: true,
            output: [systemOutput(`steering accepted: ${command.message.body}`)],
          };
        case "interrupt":
          if (!command.message.confirmedInterrupt) {
            return {
              ok: false,
              errorMessage: "interrupt requires confirmation",
              output: [systemOutput("interrupt rejected: confirmation required")],
            };
          }

          generation += 1;
          restartCount += 1;
          return {
            ok: true,
            output: [systemOutput(`mock harness restarted after interrupt: ${command.message.id}`)],
          };
        case "restart":
          generation += 1;
          restartCount += 1;
          return {
            ok: true,
            output: [systemOutput(`mock harness restarted: ${command.reason}`)],
          };
      }
    },
  };
}

function isKnownCommand(value: BridgeHarnessCommand | unknown): value is BridgeHarnessCommand {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { readonly kind?: unknown }).kind;

  return kind === "steering" || kind === "interrupt" || kind === "restart";
}
