import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm, readFile } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { connect, type Socket } from "net";
import { DaemonServer } from "../../../src/daemon/server";
import {
  serializeMessage,
  parseMessage,
  createRequest,
  type DaemonResponse,
} from "../../../src/daemon/protocol";
import type { Task, TaskStore } from "../../../src/stores/interfaces";

function createMockTaskStore(): TaskStore & { tasks: Task[] } {
  const tasks: Task[] = [];
  return {
    tasks,
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
      const task = tasks.find((t) => t.status === "pending");
      if (task) {
        task.status = "active";
        task.agent_id = agentId;
        task.updated_at = new Date().toISOString();
        return task;
      }
      return undefined;
    },
  };
}

function connectToSocket(socketPath: string): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const sock = connect(socketPath);
    sock.on("connect", () => resolve(sock));
    sock.on("error", reject);
  });
}

function sendRequest(
  sock: Socket,
  method: string,
  params?: any
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const req = createRequest(method, params);
    let buffer = "";

    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx !== -1) {
        const line = buffer.slice(0, newlineIdx);
        sock.removeListener("data", onData);
        const msg = parseMessage(line);
        if (msg) resolve(msg as DaemonResponse);
        else reject(new Error("Invalid response"));
      }
    };

    sock.on("data", onData);
    sock.write(serializeMessage(req));

    setTimeout(() => {
      sock.removeListener("data", onData);
      reject(new Error("Timeout"));
    }, 3000);
  });
}

describe("DaemonServer", () => {
  let tempDir: string;
  let store: TaskStore & { tasks: Task[] };
  let server: DaemonServer;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "daemon-test-"));
    store = createMockTaskStore();
    server = new DaemonServer({
      dataDir: tempDir,
      taskStore: store,
      idleTimeoutMs: 60000, // long idle timeout for tests
    });
  });

  afterEach(async () => {
    try {
      await server.stop();
    } catch {
      // already stopped
    }
    await rm(tempDir, { recursive: true, force: true });
  });

  test("starts and accepts connections", async () => {
    await server.start();
    const sock = await connectToSocket(server.socketPath);
    expect(sock.destroyed).toBe(false);
    sock.destroy();
  });

  test("writes PID file on start", async () => {
    await server.start();
    const pidRaw = await readFile(server.pidPath, "utf-8");
    expect(parseInt(pidRaw)).toBe(process.pid);
  });

  test("routes task.list to store", async () => {
    await server.start();
    await store.add({ description: "test task", status: "pending" });

    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "task.list");
    expect(resp.error).toBeUndefined();
    expect(resp.result).toHaveLength(1);
    expect(resp.result[0].description).toBe("test task");
    sock.destroy();
  });

  test("routes task.add to store", async () => {
    await server.start();

    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "task.add", {
      description: "new task",
      status: "pending",
    });
    expect(resp.error).toBeUndefined();
    expect(resp.result.id).toBe("t-1");
    expect(store.tasks).toHaveLength(1);
    sock.destroy();
  });

  test("routes task.claim to store", async () => {
    await server.start();
    await store.add({ description: "claimable", status: "pending" });

    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "task.claim", { agentId: "a1" });
    expect(resp.error).toBeUndefined();
    expect(resp.result.id).toBe("t-1");
    expect(resp.result.agent_id).toBe("a1");
    sock.destroy();
  });

  test("routes task.mark to store", async () => {
    await server.start();
    await store.add({ description: "markable", status: "pending" });

    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "task.mark", {
      id: "t-1",
      fields: { status: "completed" },
    });
    expect(resp.error).toBeUndefined();
    expect(store.tasks[0].status).toBe("completed");
    sock.destroy();
  });

  test("returns status info", async () => {
    await server.start();
    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "status");
    expect(resp.result.pid).toBe(process.pid);
    expect(resp.result.uptime).toBeGreaterThanOrEqual(0);
    expect(resp.result.connectedClients).toBeGreaterThanOrEqual(1);
    sock.destroy();
  });

  test("returns error for unknown method", async () => {
    await server.start();
    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "nonexistent.method");
    expect(resp.error).toContain("Unknown method");
    sock.destroy();
  });

  test("graceful shutdown cleans up socket and PID file", async () => {
    await server.start();
    const socketPath = server.socketPath;
    const pidPath = server.pidPath;

    await server.stop();

    // Socket and PID file should be gone
    expect(await Bun.file(socketPath).exists()).toBe(false);
    expect(await Bun.file(pidPath).exists()).toBe(false);
  });

  test("shutdown via request", async () => {
    await server.start();
    const sock = await connectToSocket(server.socketPath);
    const resp = await sendRequest(sock, "shutdown");
    expect(resp.result).toEqual({ ok: true });
    sock.destroy();

    // Wait for async shutdown
    await new Promise((r) => setTimeout(r, 200));
    expect(await Bun.file(server.socketPath).exists()).toBe(false);
  });

  test("tracks connected clients", async () => {
    await server.start();
    expect(server.connectedClients).toBe(0);

    const sock1 = await connectToSocket(server.socketPath);
    // Small delay for server to register
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connectedClients).toBe(1);

    const sock2 = await connectToSocket(server.socketPath);
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connectedClients).toBe(2);

    sock1.destroy();
    await new Promise((r) => setTimeout(r, 50));
    expect(server.connectedClients).toBe(1);

    sock2.destroy();
  });

  test("readPid returns PID from file", async () => {
    await server.start();
    const pid = await DaemonServer.readPid(tempDir);
    expect(pid).toBe(process.pid);
  });

  test("readPid returns null when no file", async () => {
    const pid = await DaemonServer.readPid(join(tempDir, "nonexistent"));
    expect(pid).toBeNull();
  });

  test("auto-stop after idle timeout", async () => {
    const shortIdleServer = new DaemonServer({
      dataDir: tempDir,
      taskStore: store,
      idleTimeoutMs: 100, // very short for test
    });

    await shortIdleServer.start();
    const socketPath = shortIdleServer.socketPath;

    // Wait for idle timeout
    await new Promise((r) => setTimeout(r, 300));

    expect(await Bun.file(socketPath).exists()).toBe(false);
  });
});
