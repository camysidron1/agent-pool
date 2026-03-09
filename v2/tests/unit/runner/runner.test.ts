import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Runner } from "../../../src/runner/runner";
import type { Task, TaskStore } from "../../../src/stores/interfaces";

function createMockTaskStore(): TaskStore & {
  tasks: Task[];
  claimCalls: string[];
} {
  const tasks: Task[] = [];
  const claimCalls: string[] = [];
  return {
    tasks,
    claimCalls,
    async list() {
      return [...tasks];
    },
    async get(id: string) {
      return tasks.find((t) => t.id === id);
    },
    async update(id: string, fields: Partial<Task>) {
      const task = tasks.find((t) => t.id === id);
      if (task) Object.assign(task, fields, { updated_at: new Date().toISOString() });
    },
    async add(task) {
      const t: Task = {
        ...task,
        id: `t-${tasks.length + 1}`,
        status: task.status ?? "pending",
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      tasks.push(t);
      return t;
    },
    async claim(agentId: string) {
      claimCalls.push(agentId);
      return undefined;
    },
  };
}

describe("Runner", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "runner-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("falls back to polling when daemon unavailable", async () => {
    const store = createMockTaskStore();
    const runner = new Runner({
      dataDir: tempDir,
      agentId: "test-agent",
      taskStore: store,
      pollIntervalMs: 100,
    });

    await runner.start();
    expect(runner.mode).toBe("polling");

    // Let it poll a couple times
    await new Promise((r) => setTimeout(r, 250));
    expect(store.claimCalls.length).toBeGreaterThan(0);
    expect(store.claimCalls[0]).toBe("test-agent");

    await runner.cleanup();
  });

  test("start is idempotent", async () => {
    const store = createMockTaskStore();
    const runner = new Runner({
      dataDir: tempDir,
      agentId: "test-agent",
      taskStore: store,
    });

    await runner.start();
    await runner.start(); // should not throw
    await runner.cleanup();
  });

  test("cleanup is safe to call multiple times", async () => {
    const store = createMockTaskStore();
    const runner = new Runner({
      dataDir: tempDir,
      agentId: "test-agent",
      taskStore: store,
    });

    await runner.start();
    await runner.cleanup();
    await runner.cleanup(); // should not throw
  });

  test("mode defaults to polling", async () => {
    const store = createMockTaskStore();
    const runner = new Runner({
      dataDir: tempDir,
      agentId: "test-agent",
      taskStore: store,
    });

    // Before start, mode is polling (default)
    expect(runner.mode).toBe("polling");
    await runner.cleanup();
  });
});
