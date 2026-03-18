import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, rm } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type Server } from "net";
import { DaemonClient } from "../../../src/daemon/client";
import {
  parseMessage,
  serializeMessage,
  createResponse,
  isRequest,
} from "../../../src/daemon/protocol";

describe("DaemonClient", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "client-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("returns false when no daemon is running", async () => {
    const client = new DaemonClient({
      socketPath: join(tempDir, "nonexistent.sock"),
      timeoutMs: 500,
    });
    const connected = await client.connect();
    expect(connected).toBe(false);
    expect(client.connected).toBe(false);
  });

  test("connects to a mock server", async () => {
    const sockPath = join(tempDir, "test.sock");
    const mockServer = createServer(() => {});
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    const connected = await client.connect();
    expect(connected).toBe(true);
    expect(client.connected).toBe(true);

    client.close();
    expect(client.connected).toBe(false);
    mockServer.close();
  });

  test("sends request and receives response", async () => {
    const sockPath = join(tempDir, "echo.sock");
    const mockServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            const resp = createResponse(msg.id, { echo: msg.method });
            socket.write(serializeMessage(resp));
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    const resp = await client.request("test.echo");
    expect(resp.result).toEqual({ echo: "test.echo" });

    client.close();
    mockServer.close();
  });

  test("sends request with params", async () => {
    const sockPath = join(tempDir, "params.sock");
    const mockServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            socket.write(
              serializeMessage(createResponse(msg.id, msg.params))
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    const resp = await client.request("task.add", { description: "hello" });
    expect(resp.result).toEqual({ description: "hello" });

    client.close();
    mockServer.close();
  });

  test("handles request timeout", async () => {
    const sockPath = join(tempDir, "slow.sock");
    // Server that never responds
    const mockServer = createServer(() => {});
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({
      socketPath: sockPath,
      timeoutMs: 200,
    });
    await client.connect();

    await expect(client.request("test")).rejects.toThrow("timeout");

    client.close();
    mockServer.close();
  });

  test("throws when not connected", async () => {
    const client = new DaemonClient({
      socketPath: join(tempDir, "none.sock"),
    });
    await expect(client.request("test")).rejects.toThrow("Not connected");
  });

  test("handles server disconnect", async () => {
    const sockPath = join(tempDir, "disconnect.sock");
    const mockServer = createServer((socket) => {
      // Immediately close connection
      socket.destroy();
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    // Give time for the server to destroy the socket
    await new Promise((r) => setTimeout(r, 50));
    expect(client.connected).toBe(false);

    client.close();
    mockServer.close();
  });

  test("onPush callback fires on push messages", async () => {
    const sockPath = join(tempDir, "push.sock");
    const mockServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            // Respond to the request
            socket.write(serializeMessage(createResponse(msg.id, { ok: true })));
            // Then send a push message
            socket.write(
              serializeMessage({
                id: "push",
                result: { type: "task.assigned", task: { id: "t-1" } },
              })
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    const pushMessages: any[] = [];
    client.onPush((msg) => pushMessages.push(msg));

    await client.request("runner.ready", { agentId: "agent-01" });

    // Wait for the push message to arrive
    await new Promise((r) => setTimeout(r, 50));

    expect(pushMessages).toHaveLength(1);
    expect(pushMessages[0].result.type).toBe("task.assigned");
    expect(pushMessages[0].result.task.id).toBe("t-1");

    client.close();
    mockServer.close();
  });

  test("regular request/response still works with push handler registered", async () => {
    const sockPath = join(tempDir, "pushreq.sock");
    const mockServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            socket.write(
              serializeMessage(createResponse(msg.id, { echo: msg.method }))
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    // Register push handler
    const pushMessages: any[] = [];
    client.onPush((msg) => pushMessages.push(msg));

    // Normal request should still work
    const resp = await client.request("test.echo");
    expect(resp.result).toEqual({ echo: "test.echo" });

    // No push messages should have arrived
    expect(pushMessages).toHaveLength(0);

    client.close();
    mockServer.close();
  });

  test("onDisconnect callback fires on server close", async () => {
    const sockPath = join(tempDir, "ondisconnect.sock");
    const mockServer = createServer((socket) => {
      // Close after a short delay
      setTimeout(() => socket.destroy(), 30);
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    let disconnected = false;
    client.onDisconnect(() => {
      disconnected = true;
    });

    await new Promise((r) => setTimeout(r, 100));
    expect(disconnected).toBe(true);
    expect(client.connected).toBe(false);

    client.close();
    mockServer.close();
  });

  test("multiple sequential requests", async () => {
    const sockPath = join(tempDir, "multi.sock");
    const mockServer = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString();
        let idx: number;
        while ((idx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 1);
          const msg = parseMessage(line);
          if (msg && isRequest(msg)) {
            socket.write(
              serializeMessage(createResponse(msg.id, { method: msg.method }))
            );
          }
        }
      });
    });
    await new Promise<void>((resolve) =>
      mockServer.listen(sockPath, resolve)
    );

    const client = new DaemonClient({ socketPath: sockPath });
    await client.connect();

    const r1 = await client.request("first");
    const r2 = await client.request("second");
    const r3 = await client.request("third");

    expect(r1.result.method).toBe("first");
    expect(r2.result.method).toBe("second");
    expect(r3.result.method).toBe("third");

    client.close();
    mockServer.close();
  });
});
