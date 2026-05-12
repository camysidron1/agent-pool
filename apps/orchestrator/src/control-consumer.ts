import type { QueueDrainResult, RabbitMqAdapter } from "@agent-pool/queue";

import type {
  BackendInternalApiClient,
  BackendInternalHttpResult,
  ClaimNextCommandResponse,
} from "./backend-client";
import { createQueueDecisionPolicy, type QueueDecisionPolicy } from "./queue-policy";

export type ControlQueueConsumerBackend = Pick<
  BackendInternalApiClient,
  "claimNextCommand" | "reportCommandStarted" | "reportCommandSucceeded" | "reportCommandFailed"
>;

export type CommandHandlingRequest = {
  readonly projectId: string;
  readonly command: Readonly<Record<string, unknown>>;
  readonly wakeup: Readonly<Record<string, unknown>>;
};

export type CommandHandlingResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly errorMessage: string };

export type CommandHandler = (request: CommandHandlingRequest) => CommandHandlingResult | Promise<CommandHandlingResult>;

export type ControlQueueConsumerOptions = {
  readonly projectId: string;
  readonly queue: RabbitMqAdapter;
  readonly backend: ControlQueueConsumerBackend;
  readonly commandHandler?: CommandHandler;
  readonly queuePolicy?: QueueDecisionPolicy;
};

export type ControlQueueConsumerRunResult = QueueDrainResult & {
  readonly claimed: number;
  readonly noWork: number;
  readonly commandsStarted: number;
  readonly commandsSucceeded: number;
  readonly commandsFailed: number;
};

export async function runControlQueueConsumerOnce(
  options: ControlQueueConsumerOptions,
): Promise<ControlQueueConsumerRunResult> {
  const queueName = options.queue.projectQueues(options.projectId).controlQueue;
  const commandHandler = options.commandHandler ?? unsupportedCommandHandler;
  let claimed = 0;
  let noWork = 0;
  let commandsStarted = 0;
  let commandsSucceeded = 0;
  let commandsFailed = 0;
  const queuePolicy = options.queuePolicy ?? createQueueDecisionPolicy();

  const drain = await options.queue.drainQueue<Readonly<Record<string, unknown>>>(queueName, async (message) => {
    const claim = await options.backend.claimNextCommand({ projectId: options.projectId });

    if (!claim.ok || !isClaimNextCommandResponse(claim)) {
      return queuePolicy.retry(message, "command_claim_failed");
    }

    if (!claim.body.claimed) {
      noWork += 1;
      return queuePolicy.ack();
    }

    const commandId = readStringProperty(claim.body.command, "id");
    if (!commandId) {
      return queuePolicy.deadLetter("claimed_command_missing_id");
    }

    claimed += 1;
    const started = await options.backend.reportCommandStarted({
      projectId: options.projectId,
      commandId,
    });

    if (!started.ok) {
      return queuePolicy.retry(message, "command_started_report_failed");
    }

    commandsStarted += 1;
    const handled = await commandHandler({
      projectId: options.projectId,
      command: claim.body.command,
      wakeup: message.payload,
    });

    if (handled.ok) {
      const succeeded = await options.backend.reportCommandSucceeded({
        projectId: options.projectId,
        commandId,
      });

      if (!succeeded.ok) {
        return queuePolicy.retry(message, "command_success_report_failed");
      }

      commandsSucceeded += 1;
      return queuePolicy.ack();
    }

    const failed = await options.backend.reportCommandFailed({
      projectId: options.projectId,
      commandId,
      errorMessage: handled.errorMessage,
    });

    if (!failed.ok) {
      return queuePolicy.retry(message, "command_failure_report_failed");
    }

    commandsFailed += 1;
    return queuePolicy.ack();
  });

  return {
    ...drain,
    claimed,
    noWork,
    commandsStarted,
    commandsSucceeded,
    commandsFailed,
  };
}

export function unsupportedCommandHandler(request: CommandHandlingRequest): CommandHandlingResult {
  const type = readStringProperty(request.command, "type") ?? "unknown";

  return {
    ok: false,
    errorMessage: `unsupported command type for orchestrator skeleton: ${type}`,
  };
}

function isClaimNextCommandResponse(
  result: BackendInternalHttpResult<ClaimNextCommandResponse>,
): result is BackendInternalHttpResult<ClaimNextCommandResponse> & { readonly body: ClaimNextCommandResponse } {
  const body = result.body as Partial<ClaimNextCommandResponse> | undefined;

  return body?.ok === true && typeof body.claimed === "boolean";
}

function readStringProperty(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}
