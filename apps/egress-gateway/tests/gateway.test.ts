import { afterEach, describe, expect, test } from "bun:test";
import { createServer as createTcpServer, connect as connectTcp, type Server } from "node:net";

import { loadConfig } from "@agent-pool/config";

import { createEgressGateway, encodeProxyIdentity } from "../src/gateway";

const servers: Array<{ close: () => Promise<void> }> = [];

afterEach(async () => {
  for (const server of servers.splice(0)) {
    await server.close();
  }
});

describe("egress gateway", () => {
  test("allows CONNECT to an authorized host with a valid session proxy token", async () => {
    const upstream = await listenTcpServer((socket) => {
      socket.write("ok");
      socket.end();
    });
    const reports: unknown[] = [];
    const gateway = createEgressGateway({
      config: config(),
      fetch: authzFetch({ allowedHost: "127.0.0.1", validToken: "proxy-token", reports }),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await connectThroughProxy({
      proxyPort: port,
      targetPort: upstream.port,
      token: "proxy-token",
    });

    expect(response).toContain("200 Connection Established");
    expect(response).toContain("ok");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("denies CONNECT to undeclared hosts and reports the denial", async () => {
    const reports: unknown[] = [];
    const gateway = createEgressGateway({
      config: config(),
      fetch: authzFetch({ allowedHost: "github.com", validToken: "proxy-token", reports }),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await connectThroughProxy({
      proxyPort: port,
      targetPort: 443,
      token: "proxy-token",
    });

    expect(response).toContain("403");
    expect(JSON.stringify(reports)).toContain("\"allowed\":false");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("denies missing proxy authentication before calling backend authz", async () => {
    let calls = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: (async () => {
        calls += 1;
        return json({ ok: true, allowed: true, reason: "allowed" });
      }) as typeof fetch,
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await rawProxyRequest(port, "CONNECT 127.0.0.1:443 HTTP/1.1\r\nhost: 127.0.0.1:443\r\n\r\n");

    expect(response).toContain("407");
    expect(calls).toBe(0);
  });
});

function config() {
  return loadConfig({
    AUTH_MODE: "test",
    EGRESS_GATEWAY_BACKEND_INTERNAL_URL: "http://api.internal.test",
  });
}

function authzFetch(input: {
  readonly allowedHost: string;
  readonly validToken: string;
  readonly reports: unknown[];
}): typeof fetch {
  return (async (_url, init) => {
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (String(_url).endsWith("/internal/egress/report")) {
      const { proxyToken: _redacted, ...reported } = body;
      input.reports.push(reported);
      return json({ ok: true });
    }
    const allowed = body.host === input.allowedHost && body.proxyToken === input.validToken;
    return json({
      ok: true,
      allowed,
      reason: allowed ? "allowed" : "not_declared_for_session",
      taskId: "task_1",
    });
  }) as typeof fetch;
}

async function connectThroughProxy(input: {
  readonly proxyPort: number;
  readonly targetPort: number;
  readonly token: string;
}): Promise<string> {
  const credentials = Buffer.from(`${encodeProxyIdentity("project_a", "session_1")}:${input.token}`, "utf8").toString("base64");
  return rawProxyRequest(
    input.proxyPort,
    [
      `CONNECT 127.0.0.1:${input.targetPort} HTTP/1.1`,
      `host: 127.0.0.1:${input.targetPort}`,
      `proxy-authorization: Basic ${credentials}`,
      "",
      "",
    ].join("\r\n"),
  );
}

async function rawProxyRequest(port: number, request: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connectTcp(port, "127.0.0.1");
    const chunks: Buffer[] = [];
    socket.on("connect", () => socket.write(request));
    socket.on("data", (chunk) => chunks.push(chunk));
    socket.on("error", reject);
    socket.on("close", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

async function listenTcpServer(onConnection: (socket: import("node:net").Socket) => void): Promise<{ readonly port: number; readonly close: () => Promise<void> }> {
  const server: Server = createTcpServer(onConnection);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing tcp server address");
  const handle = {
    port: address.port,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
  servers.push(handle);
  return handle;
}

function json(body: unknown): Response {
  return new Response(JSON.stringify(body), { headers: { "content-type": "application/json" } });
}

function testPort(): number {
  return 39_000 + Math.floor(Math.random() * 1000);
}
