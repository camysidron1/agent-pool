import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, writeFile, readdir, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { Watchdog, type HeartbeatData } from "../../../src/runner/watchdog";
import type { Task, TaskStore } from "../../../src/stores/interfaces";

/** Create a minimal mock TaskStore that records updates. */
function createMockTaskStore(): TaskStore & {
  updates: Array<{ id: string; fields: Partial<Task> }>;
} {
  const tasks: Task[] = [];
  const updates: Array<{ id: string; fields: Partial<Task> }> = [];
  return {
    updates,
    async list() {
      return tasks;
    },
    async get(id: string) {
      return tasks.find((t) => t.id === id);
    },
    async update(id: string, fields: Partial<Task>) {
      updates.push({ id, fields });
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
    async claim() {
      return undefined;
    },
  };
}

async function writeHeartbeatFile(
  dir: string,
  agentId: string,
  data: HeartbeatData
) {
  const { mkdir } = await import("fs/promises");
  const hbDir = join(dir, "heartbeats");
  await mkdir(hbDir, { recursive: true });
  await writeFile(join(hbDir, `${agentId}.json`), JSON.stringify(data));
}

describe("Watchdog", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "watchdog-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("detects stale heartbeat", async () => {
    const fiveMinAgo = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, "agent-01", {
      timestamp: fiveMinAgo,
      pid: process.pid, // alive PID, but stale timestamp
      task_id: "t-100",
      last_tool: "Read",
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].agentId).toBe("agent-01");
    expect(stuck[0].taskId).toBe("t-100");
    expect(stuck[0].reason).toBe("stale_heartbeat");
    expect(stuck[0].lastHeartbeat).toBe(fiveMinAgo);
  });

  test("detects dead PID", async () => {
    const recentTimestamp = new Date().toISOString();
    await writeHeartbeatFile(tempDir, "agent-02", {
      timestamp: recentTimestamp,
      pid: 999999, // almost certainly not alive
      task_id: "t-200",
      last_tool: "Bash",
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);
    expect(stuck[0].agentId).toBe("agent-02");
    expect(stuck[0].reason).toBe("dead_pid");
  });

  test("ignores fresh heartbeats", async () => {
    const now = new Date().toISOString();
    await writeHeartbeatFile(tempDir, "agent-03", {
      timestamp: now,
      pid: process.pid, // current process, definitely alive
      task_id: "t-300",
      last_tool: "Edit",
    });

    const watchdog = new Watchdog({
      dataDir: tempDir,
      staleThresholdMs: 5 * 60 * 1000,
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(0);
  });

  test("marks task blocked when detecting stuck agent", async () => {
    const store = createMockTaskStore();
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();

    await writeHeartbeatFile(tempDir, "agent-04", {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: "t-400",
      last_tool: "Read",
    });

    const logs: string[] = [];
    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      store,
      (msg) => logs.push(msg)
    );

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(1);

    // Simulate what start() does: handle stuck agents
    await (watchdog as any).handleStuckAgents(stuck);

    expect(store.updates).toHaveLength(1);
    expect(store.updates[0].id).toBe("t-400");
    expect(store.updates[0].fields.status).toBe("blocked");
    expect(store.updates[0].fields.error).toContain("stale_heartbeat");
    expect(logs.length).toBeGreaterThan(0);
  });

  test("cleans up heartbeat file after detection", async () => {
    const oldTimestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    await writeHeartbeatFile(tempDir, "agent-05", {
      timestamp: oldTimestamp,
      pid: process.pid,
      task_id: "t-500",
      last_tool: "Write",
    });

    const watchdog = new Watchdog(
      { dataDir: tempDir, staleThresholdMs: 5 * 60 * 1000 },
      null,
      () => {}
    );

    const stuck = await watchdog.scan();
    await (watchdog as any).handleStuckAgents(stuck);

    const remaining = await readdir(join(tempDir, "heartbeats"));
    expect(remaining.filter((f: string) => f.endsWith(".json"))).toHaveLength(
      0
    );
  });

  test("returns empty when no heartbeat directory exists", async () => {
    const watchdog = new Watchdog({
      dataDir: join(tempDir, "nonexistent"),
    });

    const stuck = await watchdog.scan();
    expect(stuck).toHaveLength(0);
  });

  test("writeHeartbeat creates file correctly", async () => {
    await Watchdog.writeHeartbeat(tempDir, "agent-06", "t-600", "Grep");

    const files = await readdir(join(tempDir, "heartbeats"));
    expect(files).toContain("agent-06.json");

    const raw = await Bun.file(
      join(tempDir, "heartbeats", "agent-06.json")
    ).text();
    const data: HeartbeatData = JSON.parse(raw);
    expect(data.task_id).toBe("t-600");
    expect(data.last_tool).toBe("Grep");
    expect(data.pid).toBe(process.pid);
  });

  test("clearHeartbeat removes file", async () => {
    await Watchdog.writeHeartbeat(tempDir, "agent-07", "t-700");
    await Watchdog.clearHeartbeat(tempDir, "agent-07");

    const files = await readdir(join(tempDir, "heartbeats"));
    expect(files.filter((f: string) => f.endsWith(".json"))).toHaveLength(0);
  });

  test("clearHeartbeat is idempotent", async () => {
    // Should not throw when file doesn't exist
    await Watchdog.clearHeartbeat(tempDir, "nonexistent-agent");
  });

  test("start and stop lifecycle", async () => {
    const watchdog = new Watchdog({
      dataDir: tempDir,
      scanIntervalMs: 100,
    });

    watchdog.start();
    // Starting again is idempotent
    watchdog.start();

    // Let it run briefly
    await new Promise((r) => setTimeout(r, 50));

    watchdog.stop();
    // Stopping again is idempotent
    watchdog.stop();
  });
});
