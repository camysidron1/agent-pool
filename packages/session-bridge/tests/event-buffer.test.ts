import { describe, expect, test } from "bun:test";

import {
  createBridgeEventBuffer,
  type BridgeCallbackClient,
  type BridgeCallbackEvent,
} from "../src";

describe("bridge event buffer", () => {
  test("enqueues failed callback events and flushes them in order after recovery", async () => {
    const buffer = createBridgeEventBuffer({ maxAttempts: 3 });
    const delivered: string[] = [];
    const events = [event("heartbeat", "one"), event("output", "two")];
    let fail = true;
    const client: Pick<BridgeCallbackClient, "postEvent"> = {
      postEvent: async (callbackEvent) => {
        if (fail) {
          return { ok: false, status: 503, body: { ok: false }, errorMessage: "callback unavailable" };
        }

        delivered.push(readEventMarker(callbackEvent));
        return { ok: true, status: 200, body: { ok: true } };
      },
    };

    buffer.enqueue(events[0], "initial failure");
    buffer.enqueue(events[1], "initial failure");

    const retained = await buffer.flush(client);
    fail = false;
    const deliveredResult = await buffer.flush(client);

    expect(retained).toEqual({ attempted: 2, delivered: 0, retained: 2, deadLettered: 0 });
    expect(deliveredResult).toEqual({ attempted: 2, delivered: 2, retained: 0, deadLettered: 0 });
    expect(delivered).toEqual(["one", "two"]);
    expect(buffer.pending).toEqual([]);
    expect(buffer.deadLetters).toEqual([]);
  });

  test("dead-letters callback events after bounded retry exhaustion", async () => {
    const buffer = createBridgeEventBuffer({
      maxAttempts: 2,
      clock: { now: () => new Date("2026-01-01T00:00:00.000Z") },
    });
    const client: Pick<BridgeCallbackClient, "postEvent"> = {
      postEvent: async () => ({ ok: false, status: 500, body: { ok: false }, errorMessage: "still down" }),
    };

    buffer.enqueue(event("heartbeat", "one"));

    const first = await buffer.flush(client);
    const second = await buffer.flush(client);

    expect(first).toEqual({ attempted: 1, delivered: 0, retained: 1, deadLettered: 0 });
    expect(second).toEqual({ attempted: 1, delivered: 0, retained: 0, deadLettered: 1 });
    expect(buffer.pending).toEqual([]);
    expect(buffer.deadLetters).toMatchObject([
      {
        id: "bridge_event_1",
        attempts: 2,
        lastError: "still down",
        deadLetteredAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });
});

function event(kind: "heartbeat" | "output", marker: string): BridgeCallbackEvent {
  if (kind === "heartbeat") {
    return {
      kind,
      projectId: "project_a",
      taskId: "task_1",
      sessionId: "session_1",
      observedAt: marker,
    };
  }

  return {
    kind,
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    stream: "stdout",
    sequence: 1,
    byteOffset: 0,
    text: marker,
    observedAt: "2026-01-01T00:00:00.000Z",
  };
}

function readEventMarker(event: BridgeCallbackEvent): string {
  if (event.kind === "heartbeat") return event.observedAt;
  if (event.kind === "output") return event.text;
  return event.kind;
}
