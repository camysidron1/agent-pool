import type { QueueDrainResult, RabbitMqAdapter } from "@agent-pool/queue";

import type {
  BackendInternalApiClient,
  BackendInternalHttpResult,
  ClaimNextTaskResponse,
} from "./backend-client";
import type { CapacityLimiter } from "./capacity";
import type { OrchestratorMetricsRecorder } from "./metrics";
import { createQueueDecisionPolicy, type QueueDecisionPolicy } from "./queue-policy";

export type TaskQueueConsumerBackend = Pick<
  BackendInternalApiClient,
  "claimNextTask" | "reportStartupSucceeded" | "reportStartupFailed"
>;

export type TaskRuntimeStartupRequest = {
  readonly projectId: string;
  readonly task: Readonly<Record<string, unknown>>;
  readonly session: Readonly<Record<string, unknown>>;
  readonly wakeup: Readonly<Record<string, unknown>>;
};

export type TaskRuntimeStartupResult =
  | { readonly ok: true; readonly runtimeSessionId?: string; readonly afterStartup?: () => Promise<void> }
  | { readonly ok: false; readonly errorMessage: string };

export type TaskRuntimeStarter = (
  request: TaskRuntimeStartupRequest,
) => TaskRuntimeStartupResult | Promise<TaskRuntimeStartupResult>;

export type TaskQueueConsumerOptions = {
  readonly projectId: string;
  readonly queue: RabbitMqAdapter;
  readonly backend: TaskQueueConsumerBackend;
  readonly runtimeStarter: TaskRuntimeStarter;
  readonly runtimeProvider?: string;
  readonly sessionIdFactory?: () => string;
  readonly capacityLimiter?: CapacityLimiter;
  readonly capacityRetryDelayMs?: number;
  readonly queuePolicy?: QueueDecisionPolicy;
  readonly metrics?: OrchestratorMetricsRecorder;
};

export type TaskQueueConsumerRunResult = QueueDrainResult & {
  readonly claimed: number;
  readonly noWork: number;
  readonly startupsSucceeded: number;
  readonly startupsFailed: number;
};

export async function runTaskQueueConsumerOnce(
  options: TaskQueueConsumerOptions,
): Promise<TaskQueueConsumerRunResult> {
  const queueName = options.queue.projectQueues(options.projectId).taskQueue;
  let claimed = 0;
  let noWork = 0;
  let startupsSucceeded = 0;
  let startupsFailed = 0;
  const queuePolicy = options.queuePolicy ?? createQueueDecisionPolicy();

  const drain = await options.queue.drainQueue<Readonly<Record<string, unknown>>>(queueName, async (message) => {
    const lease = options.capacityLimiter?.acquire() ?? null;

    if (options.capacityLimiter && !lease) {
      return queuePolicy.retry(message, "task_capacity_full", options.capacityRetryDelayMs ?? queuePolicy.retryDelayMs);
    }

    try {
      const claim = await options.backend.claimNextTask({
        projectId: options.projectId,
        sessionId: options.sessionIdFactory?.(),
        runtimeProvider: options.runtimeProvider,
      });

      if (!claim.ok || !isClaimNextTaskResponse(claim)) {
        return queuePolicy.retry(message, "task_claim_failed");
      }

      if (!claim.body.claimed) {
        noWork += 1;
        return queuePolicy.ack();
      }

      const sessionId = readStringProperty(claim.body.session, "id");
      if (!sessionId) {
        return queuePolicy.deadLetter("claimed_task_missing_session_id");
      }

      claimed += 1;
      const startup = await options.runtimeStarter({
        projectId: options.projectId,
        task: claim.body.task,
        session: claim.body.session,
        wakeup: message.payload,
      });

      if (startup.ok) {
        const report = await options.backend.reportStartupSucceeded({
          projectId: options.projectId,
          sessionId,
          runtimeSessionId: startup.runtimeSessionId,
        });

        if (!report.ok) {
          return queuePolicy.retry(message, "startup_success_report_failed");
        }

        await startup.afterStartup?.();
        startupsSucceeded += 1;
        return queuePolicy.ack();
      }

      const report = await options.backend.reportStartupFailed({
        projectId: options.projectId,
        sessionId,
        errorMessage: startup.errorMessage,
      });

      if (!report.ok) {
        return queuePolicy.retry(message, "startup_failure_report_failed");
      }

      startupsFailed += 1;
      return queuePolicy.ack();
    } finally {
      lease?.release();
    }
  });

  const result = {
    ...drain,
    claimed,
    noWork,
    startupsSucceeded,
    startupsFailed,
  };

  options.metrics?.recordTaskConsumerRun(result);
  return result;
}

function isClaimNextTaskResponse(
  result: BackendInternalHttpResult<ClaimNextTaskResponse>,
): result is BackendInternalHttpResult<ClaimNextTaskResponse> & { readonly body: ClaimNextTaskResponse } {
  const body = result.body as Partial<ClaimNextTaskResponse> | undefined;

  return body?.ok === true && typeof body.claimed === "boolean";
}

function readStringProperty(record: Readonly<Record<string, unknown>>, key: string): string | undefined {
  const value = record[key];

  return typeof value === "string" && value.length > 0 ? value : undefined;
}
