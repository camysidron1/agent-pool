import type { QueueDrainResult, RabbitMqAdapter } from "@agent-pool/queue";

import type { CapacityLimiter } from "./capacity";
import type { ReconciliationOnceResult } from "./reconciliation-loop";

export type OrchestratorMetricsCounters = {
  readonly taskConsumerRuns: number;
  readonly controlConsumerRuns: number;
  readonly taskClaims: number;
  readonly commandClaims: number;
  readonly queueAcked: number;
  readonly queueRetried: number;
  readonly queueDeadLettered: number;
  readonly reconcileRuns: number;
  readonly reconcileFailures: number;
};

export type OrchestratorMetricsRecorder = {
  readonly snapshot: () => OrchestratorMetricsCounters;
  readonly recordTaskConsumerRun: (result: QueueDrainResult & { readonly claimed: number }) => void;
  readonly recordControlConsumerRun: (result: QueueDrainResult & { readonly claimed: number }) => void;
  readonly recordReconciliationRun: (result: ReconciliationOnceResult) => void;
};

export type RenderOrchestratorMetricsOptions = {
  readonly taskQueueName: string;
  readonly queue: RabbitMqAdapter;
  readonly capacityLimiter?: CapacityLimiter;
  readonly metrics?: OrchestratorMetricsRecorder | Partial<OrchestratorMetricsCounters>;
};

const ZERO_COUNTERS: OrchestratorMetricsCounters = {
  taskConsumerRuns: 0,
  controlConsumerRuns: 0,
  taskClaims: 0,
  commandClaims: 0,
  queueAcked: 0,
  queueRetried: 0,
  queueDeadLettered: 0,
  reconcileRuns: 0,
  reconcileFailures: 0,
};

export function createOrchestratorMetrics(
  initial: Partial<OrchestratorMetricsCounters> = {},
): OrchestratorMetricsRecorder {
  const counters = { ...ZERO_COUNTERS, ...initial };

  return {
    snapshot: () => ({ ...counters }),
    recordTaskConsumerRun(result): void {
      counters.taskConsumerRuns += 1;
      counters.taskClaims += result.claimed;
      counters.queueAcked += result.acked;
      counters.queueRetried += result.retried;
      counters.queueDeadLettered += result.deadLettered;
    },
    recordControlConsumerRun(result): void {
      counters.controlConsumerRuns += 1;
      counters.commandClaims += result.claimed;
      counters.queueAcked += result.acked;
      counters.queueRetried += result.retried;
      counters.queueDeadLettered += result.deadLettered;
    },
    recordReconciliationRun(result): void {
      counters.reconcileRuns += 1;
      if (!result.ok) {
        counters.reconcileFailures += 1;
      }
      counters.taskClaims += result.taskClaimed ? 1 : 0;
      counters.commandClaims += result.commandClaimed ? 1 : 0;
    },
  };
}

export function renderOrchestratorMetrics(options: RenderOrchestratorMetricsOptions): string {
  const counters = readCounters(options.metrics);
  const capacity = options.capacityLimiter;

  return [
    "# metrics placeholder for agent-pool-orchestrator",
    `agent_pool_orchestrator_info{task_queue="${options.taskQueueName}"} 1`,
    "agent_pool_orchestrator_backend_internal_configured 1",
    "agent_pool_orchestrator_queue_adapter_initialized 1",
    "agent_pool_orchestrator_storage_adapter_initialized 1",
    `agent_pool_orchestrator_queue_pending ${options.queue.pendingMessages.length}`,
    `agent_pool_orchestrator_queue_dead_letters ${options.queue.deadLetters.length}`,
    `agent_pool_orchestrator_queue_ack_total ${counters.queueAcked}`,
    `agent_pool_orchestrator_queue_retry_total ${counters.queueRetried}`,
    `agent_pool_orchestrator_queue_dead_letter_total ${counters.queueDeadLettered}`,
    `agent_pool_orchestrator_task_consumer_runs_total ${counters.taskConsumerRuns}`,
    `agent_pool_orchestrator_control_consumer_runs_total ${counters.controlConsumerRuns}`,
    `agent_pool_orchestrator_task_claim_total ${counters.taskClaims}`,
    `agent_pool_orchestrator_command_claim_total ${counters.commandClaims}`,
    `agent_pool_orchestrator_capacity_active ${capacity?.active ?? 0}`,
    `agent_pool_orchestrator_capacity_max ${capacity?.maxConcurrent ?? 0}`,
    `agent_pool_orchestrator_capacity_available ${capacity?.available ? 1 : 0}`,
    `agent_pool_orchestrator_reconcile_runs_total ${counters.reconcileRuns}`,
    `agent_pool_orchestrator_reconcile_failures_total ${counters.reconcileFailures}`,
    "",
  ].join("\n");
}

function readCounters(metrics: RenderOrchestratorMetricsOptions["metrics"]): OrchestratorMetricsCounters {
  if (!metrics) return ZERO_COUNTERS;

  if ("snapshot" in metrics) {
    return metrics.snapshot();
  }

  return { ...ZERO_COUNTERS, ...metrics };
}
