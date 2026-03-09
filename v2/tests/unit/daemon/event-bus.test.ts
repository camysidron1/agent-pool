import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, readFile, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { EventBus, type PoolEvent, type EventType } from "../../../src/daemon/event-bus";

describe("EventBus", () => {
  let bus: EventBus;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    bus = new EventBus(null, (msg) => logs.push(msg));
  });

  function makeEvent(type: EventType = "task.created"): PoolEvent {
    return {
      type,
      timestamp: new Date().toISOString(),
      payload: { taskId: "t-001" },
    };
  }

  test("subscribe handler, emit event, handler called with correct payload", () => {
    const received: PoolEvent[] = [];
    bus.on("task.created", (event) => {
      received.push(event);
    });

    const event = makeEvent("task.created");
    bus.emit(event);

    expect(received).toHaveLength(1);
    expect(received[0]).toBe(event);
    expect(received[0].payload.taskId).toBe("t-001");
  });

  test("multiple handlers on same event type all fire", () => {
    let count = 0;
    bus.on("task.completed", () => { count++; });
    bus.on("task.completed", () => { count++; });
    bus.on("task.completed", () => { count++; });

    bus.emit(makeEvent("task.completed"));
    expect(count).toBe(3);
  });

  test("handler error doesn't crash bus — other handlers still fire", () => {
    const received: string[] = [];

    bus.on("task.blocked", () => {
      received.push("first");
    });
    bus.on("task.blocked", () => {
      throw new Error("boom");
    });
    bus.on("task.blocked", () => {
      received.push("third");
    });

    bus.emit(makeEvent("task.blocked"));

    expect(received).toEqual(["first", "third"]);
    expect(logs.some((l) => l.includes("boom"))).toBe(true);
  });

  test("off() removes handler — no longer called on emit", () => {
    let called = false;
    const handler = () => { called = true; };

    bus.on("task.cancelled", handler);
    bus.off("task.cancelled", handler);
    bus.emit(makeEvent("task.cancelled"));

    expect(called).toBe(false);
  });

  test("events with no subscribers don't error", () => {
    expect(() => bus.emit(makeEvent("agent.ready"))).not.toThrow();
  });

  test("async handler errors are caught and logged", async () => {
    bus.on("agent.stuck", async () => {
      throw new Error("async boom");
    });

    bus.emit(makeEvent("agent.stuck"));

    // Give the async rejection time to be caught
    await new Promise((r) => setTimeout(r, 10));
    expect(logs.some((l) => l.includes("async boom"))).toBe(true);
  });

  test("handlers for different event types are independent", () => {
    let createdCount = 0;
    let completedCount = 0;

    bus.on("task.created", () => { createdCount++; });
    bus.on("task.completed", () => { completedCount++; });

    bus.emit(makeEvent("task.created"));

    expect(createdCount).toBe(1);
    expect(completedCount).toBe(0);
  });

  describe("event persistence", () => {
    let tmpDir: string;

    beforeEach(async () => {
      tmpDir = await mkdtemp(join(tmpdir(), "eventbus-"));
    });

    afterEach(async () => {
      await rm(tmpDir, { recursive: true, force: true });
    });

    test("persistEvent appends to JSONL file", async () => {
      const eventsFile = join(tmpDir, "events.jsonl");
      const persistBus = new EventBus(eventsFile);

      const event1 = makeEvent("task.created");
      const event2 = makeEvent("task.completed");

      await persistBus.persistEvent(event1);
      await persistBus.persistEvent(event2);

      const content = await readFile(eventsFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0]).type).toBe("task.created");
      expect(JSON.parse(lines[1]).type).toBe("task.completed");
    });

    test("emit persists event when eventsFile is configured", async () => {
      const eventsFile = join(tmpDir, "events.jsonl");
      const persistBus = new EventBus(eventsFile);

      persistBus.emit(makeEvent("task.claimed"));

      // Wait for async persist
      await new Promise((r) => setTimeout(r, 50));

      const content = await readFile(eventsFile, "utf-8");
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(lines[0]).type).toBe("task.claimed");
    });
  });
});
