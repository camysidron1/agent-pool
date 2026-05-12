import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import type { BackendInternalApiClient } from "../src/backend-client";
import { createCapacityLimiter } from "../src/capacity";
import type { OrchestratorWorkerLoopScheduler } from "../src/worker-loops";
import { createOrchestratorWorkerLoops } from "../src/worker-loops";

describe("orchestrator worker loops", () => {
  test("runs project task control and reconcile ticks with fake runtime callbacks", async () => {
    const config = loadConfig({
      AUTH_MODE: "test",
      CONTROL_PLANE_WORKER_POLL_INTERVAL_MS: "25",
      CONTROL_PLANE_RECONCILE_INTERVAL_MS: "50",
    });
    const queue = createRabbitMqAdapter(config.rabbitmq);
    const calls: Array<{ readonly method: string; readonly input: unknown }> = [];
    const bridgeCallbacks: string[] = [];
    let taskClaims = 0;
    let commandClaims = 0;
    const backend = createBackend({
      claimNextTask: async (input) => {
        taskClaims += 1;
        calls.push({ method: "claimNextTask", input });
        return taskClaims === 1
          ? {
              ok: true,
              status: 200,
              body: {
                ok: true,
                claimed: true,
                task: { id: "compose-smoke-task-1", title: "Smoke" },
                session: {
                  id: "session_smoke",
                  bridge: {
                    projectId: "compose-smoke",
                    taskId: "compose-smoke-task-1",
                    sessionId: "session_smoke",
                    callbackBaseUrl: "http://api.test",
                    sessionToken: {
                      headerName: "x-agent-pool-session-token",
                      token: "bridge-token",
                    },
                  },
                },
                event: { id: "event_task", projectId: "compose-smoke", type: "task.claimed" },
                outbox: { id: "outbox_task", projectId: "compose-smoke", eventId: "event_task", routingKey: "project.compose-smoke.control" },
              },
            }
          : { ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_eligible_task" } };
      },
      reportStartupSucceeded: async (input) => {
        calls.push({ method: "reportStartupSucceeded", input });
        return {
          ok: true,
          status: 200,
          body: { ok: true, idempotent: false, session: { id: input.sessionId }, task: { id: "compose-smoke-task-1" }, event: null, outbox: null },
        };
      },
      claimNextCommand: async (input) => {
        commandClaims += 1;
        calls.push({ method: "claimNextCommand", input });
        return commandClaims === 1
          ? {
              ok: true,
              status: 200,
              body: {
                ok: true,
                claimed: true,
                command: { id: "command_smoke", type: "cleanup" },
                event: { id: "event_command", projectId: "compose-smoke", type: "command.claimed" },
                outbox: { id: "outbox_command", projectId: "compose-smoke", eventId: "event_command", routingKey: "project.compose-smoke.control" },
              },
            }
          : { ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_queued_command" } };
      },
      reportCommandStarted: async (input) => {
        calls.push({ method: "reportCommandStarted", input });
        return {
          ok: true,
          status: 200,
          body: { ok: true, idempotent: false, command: { id: input.commandId }, event: null, outbox: null },
        };
      },
      reportCommandFailed: async (input) => {
        calls.push({ method: "reportCommandFailed", input });
        return {
          ok: true,
          status: 200,
          body: { ok: true, idempotent: false, command: { id: input.commandId }, event: null, outbox: null },
        };
      },
      reconcile: async (input) => {
        calls.push({ method: "reconcile", input });
        return { ok: true, status: 200, body: { ok: true, stale: [], lost: [], events: [], outbox: [] } };
      },
    });
    const loops = createOrchestratorWorkerLoops({
      config,
      queue,
      backend,
      fakeRuntime: {
        sessionIdFactory: () => "runtime_fake_loop",
        clock: { now: () => new Date("2026-05-12T12:00:00.000Z") },
        fetch: async (input) => {
          const request = new Request(input);
          const url = new URL(request.url);
          bridgeCallbacks.push(url.pathname);
          return url.pathname === "/steering/poll"
            ? Response.json({ ok: true, messages: [] })
            : Response.json({ ok: true, accepted: true });
        },
      },
    });

    queue.publishProjectTaskHint("compose-smoke", { taskId: "compose-smoke-task-1" });
    queue.publishProjectControlHint("compose-smoke", { commandId: "command_smoke" });

    const task = await loops.tickTask();
    const control = await loops.tickControl();
    const reconcile = await loops.tickReconcile();

    expect(task).toMatchObject({
      processed: 1,
      acked: 1,
      claimed: 1,
      startupsSucceeded: 1,
      startupsFailed: 0,
    });
    expect(control).toMatchObject({
      processed: 1,
      acked: 1,
      claimed: 1,
      commandsStarted: 1,
      commandsSucceeded: 0,
      commandsFailed: 1,
    });
    expect(reconcile).toMatchObject({
      ok: true,
      taskClaimed: false,
      commandClaimed: false,
    });
    expect(calls).toEqual([
      { method: "claimNextTask", input: { projectId: "compose-smoke", sessionId: undefined, runtimeProvider: "fake" } },
      {
        method: "reportStartupSucceeded",
        input: { projectId: "compose-smoke", sessionId: "session_smoke", runtimeSessionId: "runtime_fake_loop" },
      },
      { method: "claimNextCommand", input: { projectId: "compose-smoke" } },
      { method: "reportCommandStarted", input: { projectId: "compose-smoke", commandId: "command_smoke" } },
      {
        method: "reportCommandFailed",
        input: {
          projectId: "compose-smoke",
          commandId: "command_smoke",
          errorMessage: "unsupported command type for orchestrator skeleton: cleanup",
        },
      },
      {
        method: "reconcile",
        input: {
          projectId: "compose-smoke",
          staleBefore: expect.any(String),
          lostBefore: expect.any(String),
          now: expect.any(String),
        },
      },
    ]);
    expect(bridgeCallbacks).toContain("/callbacks/heartbeat");
    expect(bridgeCallbacks).toContain("/callbacks/final_response");
    expect(bridgeCallbacks).toContain("/callbacks/completion");
    expect(loops.state.task).toMatchObject({ ticks: 1, failures: 0, inFlight: false });
    expect(loops.state.control).toMatchObject({ ticks: 1, failures: 0, inFlight: false });
    expect(loops.state.reconcile).toMatchObject({ ticks: 1, failures: 0, inFlight: false });
  });

  test("starts and stops all worker timers with configured cadence", () => {
    const intervals: number[] = [];
    const cleared: unknown[] = [];
    const scheduler: OrchestratorWorkerLoopScheduler = {
      setInterval(_callback, intervalMs) {
        intervals.push(intervalMs);
        return `timer-${intervals.length}`;
      },
      clearInterval(handle) {
        cleared.push(handle);
      },
    };
    const config = loadConfig({
      AUTH_MODE: "test",
      CONTROL_PLANE_WORKER_POLL_INTERVAL_MS: "25",
      CONTROL_PLANE_RECONCILE_INTERVAL_MS: "50",
    });
    const loops = createOrchestratorWorkerLoops({
      config,
      queue: createRabbitMqAdapter(config.rabbitmq),
      backend: createBackend(),
      scheduler,
      runtimeStarter: async () => ({ ok: true, runtimeSessionId: "runtime_unused" }),
    });

    loops.start();
    loops.start();

    expect(loops.state.task.running).toBe(true);
    expect(loops.state.control.running).toBe(true);
    expect(loops.state.reconcile.running).toBe(true);
    expect(intervals).toEqual([25, 25, 50]);

    loops.stop();
    loops.stop();

    expect(loops.state.task.running).toBe(false);
    expect(loops.state.control.running).toBe(false);
    expect(loops.state.reconcile.running).toBe(false);
    expect(cleared).toEqual(["timer-1", "timer-2", "timer-3"]);
  });

  test("task loop retries capacity-full wakeups without claiming or hot-looping", async () => {
    const config = loadConfig({ AUTH_MODE: "test" });
    const queue = createRabbitMqAdapter(config.rabbitmq);
    let claims = 0;
    const loops = createOrchestratorWorkerLoops({
      config,
      queue,
      backend: createBackend({
        claimNextTask: async () => {
          claims += 1;
          return { ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_eligible_task" } };
        },
      }),
      capacityLimiter: createCapacityLimiter({ maxConcurrent: 0 }),
      runtimeStarter: async () => ({ ok: true, runtimeSessionId: "runtime_unused" }),
    });

    queue.publishProjectTaskHint("compose-smoke", { taskId: "compose-smoke-task-1" });
    const result = await loops.tickTask();

    expect(result).toMatchObject({
      processed: 1,
      acked: 0,
      retried: 1,
      deadLettered: 0,
      claimed: 0,
    });
    expect(claims).toBe(0);
    expect(queue.pendingMessages).toMatchObject([
      {
        attempts: 2,
        lastRetryReason: "task_capacity_full",
      },
    ]);
  });
});

function createBackend(overrides: Partial<BackendInternalApiClient> = {}): BackendInternalApiClient {
  return {
    checkHealth: async () => ({ ok: true, status: 200, body: { ok: true } }),
    claimNextTask: async () => ({ ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_eligible_task" } }),
    claimNextCommand: async () => ({ ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_queued_command" } }),
    reportCommandStarted: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, idempotent: false, command: { id: input.commandId }, event: null, outbox: null },
    }),
    reportCommandSucceeded: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, idempotent: false, command: { id: input.commandId }, event: null, outbox: null },
    }),
    reportCommandFailed: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, idempotent: false, command: { id: input.commandId }, event: null, outbox: null },
    }),
    reportStartupSucceeded: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, idempotent: false, session: { id: input.sessionId }, task: { id: "task_1" }, event: null, outbox: null },
    }),
    reportStartupFailed: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, idempotent: false, session: { id: input.sessionId }, task: { id: "task_1" }, event: null, outbox: null },
    }),
    reportSessionHeartbeat: async (input) => ({
      ok: true,
      status: 200,
      body: { ok: true, session: { id: input.sessionId }, event: { id: "event_heartbeat", projectId: input.projectId, type: "session.heartbeat" }, outbox: { id: "outbox_heartbeat", projectId: input.projectId, eventId: "event_heartbeat", routingKey: "events" } },
    }),
    reconcile: async () => ({ ok: true, status: 200, body: { ok: true, stale: [], lost: [], events: [], outbox: [] } }),
    ...overrides,
  };
}
