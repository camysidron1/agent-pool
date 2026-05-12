import { describe, expect, test } from "bun:test";

import type { ReconciliationBackend, ReconciliationScheduler } from "../src/reconciliation-loop";
import { createReconciliationLoop, runReconciliationOnce } from "../src/reconciliation-loop";

describe("orchestrator reconciliation loop", () => {
  test("reconciles stale/lost thresholds and handles task/command no-work claims", async () => {
    const calls: unknown[] = [];
    const backend: ReconciliationBackend = {
      reconcile: async (input) => {
        calls.push({ method: "reconcile", input });
        return {
          ok: true,
          status: 200,
          body: {
            ok: true,
            stale: [{ id: "session_stale" }],
            lost: [{ id: "session_lost" }],
            events: [],
            outbox: [],
          },
        };
      },
      claimNextTask: async (input) => {
        calls.push({ method: "claimNextTask", input });
        return {
          ok: true,
          status: 200,
          body: { ok: true, claimed: false, reason: "no_eligible_task" },
        };
      },
      claimNextCommand: async (input) => {
        calls.push({ method: "claimNextCommand", input });
        return {
          ok: true,
          status: 200,
          body: { ok: true, claimed: false, reason: "no_queued_command" },
        };
      },
    };

    const result = await runReconciliationOnce({
      projectId: "project_a",
      backend,
      clock: { now: () => new Date("2026-01-01T00:10:00.000Z") },
      staleAfterMs: 60_000,
      lostAfterMs: 300_000,
      runtimeProvider: "test-runtime",
    });

    expect(result).toEqual({
      ok: true,
      reconcileStatus: 200,
      staleCount: 1,
      lostCount: 1,
      taskClaimed: false,
      taskNoWork: true,
      commandClaimed: false,
      commandNoWork: true,
    });
    expect(calls).toEqual([
      {
        method: "reconcile",
        input: {
          projectId: "project_a",
          staleBefore: "2026-01-01T00:09:00.000Z",
          lostBefore: "2026-01-01T00:05:00.000Z",
          now: "2026-01-01T00:10:00.000Z",
        },
      },
      {
        method: "claimNextTask",
        input: { projectId: "project_a", runtimeProvider: "test-runtime" },
      },
      {
        method: "claimNextCommand",
        input: { projectId: "project_a" },
      },
    ]);
  });

  test("starts and stops with an injectable scheduler without leaking timers", async () => {
    const backend: ReconciliationBackend = {
      reconcile: async () => ({ ok: true, status: 200, body: { ok: true, stale: [], lost: [], events: [], outbox: [] } }),
      claimNextTask: async () => ({ ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_eligible_task" } }),
      claimNextCommand: async () => ({ ok: true, status: 200, body: { ok: true, claimed: false, reason: "no_queued_command" } }),
    };
    const scheduled: Array<() => void | Promise<void>> = [];
    const cleared: unknown[] = [];
    const scheduler: ReconciliationScheduler = {
      setInterval: (callback, intervalMs) => {
        scheduled.push(callback);
        return { id: "timer_1", intervalMs };
      },
      clearInterval: (handle) => {
        cleared.push(handle);
      },
    };

    const loop = createReconciliationLoop({
      backend,
      intervalMs: 1000,
      scheduler,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });

    expect(loop.running).toBe(false);
    loop.start();
    loop.start();

    expect(loop.running).toBe(true);
    expect(scheduled).toHaveLength(1);

    await scheduled[0]?.();
    loop.stop();
    loop.stop();

    expect(loop.running).toBe(false);
    expect(cleared).toEqual([{ id: "timer_1", intervalMs: 1000 }]);
  });
});
