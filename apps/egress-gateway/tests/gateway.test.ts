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
      fetch: authzFetch({ allowedHost: "github.com", validToken: "proxy-token", reports }),
      resolveHostAddresses: publicResolver(),
      connectTcp: (port) => connectTcp(port, "127.0.0.1"),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await connectThroughProxy({
      proxyPort: port,
      targetHost: "github.com",
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
      resolveHostAddresses: publicResolver(),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await connectThroughProxy({
      proxyPort: port,
      targetHost: "evil.test",
      targetPort: 443,
      token: "proxy-token",
    });

    expect(response).toContain("403");
    expect(JSON.stringify(reports)).toContain("\"allowed\":false");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("denies IP literal and private DNS targets before opening CONNECT upstreams", async () => {
    const reports: unknown[] = [];
    let connectCalls = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: authzFetch({ allowedHost: "github.com", validToken: "proxy-token", reports }),
      resolveHostAddresses: async (host) => (host === "github.com" ? ["10.0.0.4"] : ["93.184.216.34"]),
      connectTcp: (port, host) => {
        connectCalls += 1;
        return connectTcp(port, host);
      },
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const literal = await connectThroughProxy({
      proxyPort: port,
      targetHost: "127.0.0.1",
      targetPort: 443,
      token: "proxy-token",
    });
    const rebound = await connectThroughProxy({
      proxyPort: port,
      targetHost: "github.com",
      targetPort: 443,
      token: "proxy-token",
    });

    expect(literal).toContain("403");
    expect(rebound).toContain("403");
    expect(JSON.stringify(reports)).toContain("ip_literal_forbidden");
    expect(JSON.stringify(reports)).toContain("dns_target_not_public");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
    expect(connectCalls).toBe(0);
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

  test("proxies and caches allowed npm package metadata without logging proxy secrets", async () => {
    const reports: unknown[] = [];
    const logs: unknown[] = [];
    let upstreamCalls = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: packageProxyFetch({
        allowed: true,
        validToken: "proxy-token",
        reports,
        onUpstream: () => {
          upstreamCalls += 1;
          return json({ name: "@agent-pool/sdk", version: "1.0.0" });
        },
      }),
      resolveHostAddresses: publicResolver(),
      logger: (event) => logs.push(event),
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const first = await packageProxyRequest(port, "@agent-pool/sdk", "proxy-token");
    const second = await packageProxyRequest(port, "@agent-pool/sdk", "proxy-token");

    expect(first).toContain("200 OK");
    expect(first).toContain("@agent-pool/sdk");
    expect(second).toContain("200 OK");
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(logs)).toContain("package.proxy.cache_miss");
    expect(JSON.stringify(logs)).toContain("package.proxy.cache_hit");
    expect(JSON.stringify(logs)).not.toContain("proxy-token");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("denies undeclared package proxy requests before upstream fetch", async () => {
    let upstreamCalls = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: packageProxyFetch({
        allowed: false,
        validToken: "proxy-token",
        reports: [],
        onUpstream: () => {
          upstreamCalls += 1;
          return json({ ok: true });
        },
      }),
      resolveHostAddresses: publicResolver(),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await packageProxyRequest(port, "left-pad", "proxy-token");

    expect(response).toContain("403");
    expect(response).toContain("package_scope_not_declared");
    expect(upstreamCalls).toBe(0);
  });

  test("denies malicious npm metadata with lifecycle install scripts", async () => {
    const reports: unknown[] = [];
    const logs: unknown[] = [];
    let upstreamCalls = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: packageProxyFetch({
        allowed: true,
        validToken: "proxy-token",
        reports,
        onUpstream: () => {
          upstreamCalls += 1;
          return json({
            name: "@agent-pool/malicious",
            versions: {
              "1.0.0": {
                scripts: {
                  postinstall: "node ./steal-token.js",
                },
              },
            },
          });
        },
      }),
      resolveHostAddresses: publicResolver(),
      logger: (event) => logs.push(event),
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await packageProxyRequest(port, "@agent-pool/malicious", "proxy-token");

    expect(response).toContain("403");
    expect(response).toContain("package_lifecycle_script_forbidden");
    expect(upstreamCalls).toBe(1);
    expect(JSON.stringify(reports)).toContain("\"decision\":\"denied\"");
    expect(JSON.stringify(reports)).toContain("package_lifecycle_script_forbidden");
    expect(JSON.stringify(logs)).toContain("package.proxy.denied");
    expect(JSON.stringify(logs)).not.toContain("proxy-token");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("reports failed package upstream resolutions", async () => {
    const reports: unknown[] = [];
    const gateway = createEgressGateway({
      config: config(),
      fetch: packageProxyFetch({
        allowed: true,
        validToken: "proxy-token",
        reports,
        onUpstream: () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
      }),
      resolveHostAddresses: publicResolver(),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await packageProxyRequest(port, "@agent-pool/missing", "proxy-token");

    expect(response).toContain("404");
    expect(JSON.stringify(reports)).toContain("\"decision\":\"failed\"");
    expect(JSON.stringify(reports)).toContain("upstream_404");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
  });

  test("denies package proxy redirects to undeclared hosts without following them", async () => {
    const reports: unknown[] = [];
    let redirectedFetches = 0;
    const gateway = createEgressGateway({
      config: config(),
      fetch: packageProxyFetch({
        allowed: true,
        validToken: "proxy-token",
        reports,
        onUpstream: (url) => {
          if (url.startsWith("https://evil.test/")) {
            redirectedFetches += 1;
            return json({ name: "evil" });
          }
          return new Response("", { status: 302, headers: { location: "https://evil.test/left-pad" } });
        },
      }),
      resolveHostAddresses: publicResolver(),
      logger: () => undefined,
    });
    const port = testPort();
    await gateway.listen(port, "127.0.0.1");
    servers.push(gateway);

    const response = await packageProxyRequest(port, "left-pad", "proxy-token");

    expect(response).toContain("403");
    expect(response).toContain("redirect_not_declared_for_session");
    expect(redirectedFetches).toBe(0);
    expect(JSON.stringify(reports)).toContain("\"host\":\"evil.test\"");
    expect(JSON.stringify(reports)).not.toContain("proxy-token");
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

function packageProxyFetch(input: {
  readonly allowed: boolean;
  readonly validToken: string;
  readonly reports: unknown[];
  readonly onUpstream: (url: string) => Response;
}): typeof fetch {
  return (async (url, init) => {
    const textUrl = String(url);
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (textUrl.endsWith("/internal/packages/authorize")) {
      return json({
        ok: true,
        allowed: input.allowed && body.proxyToken === input.validToken,
        reason: input.allowed ? "allowed" : "package_scope_not_declared",
        audit: { id: "pkg_audit_1" },
      });
    }
    if (textUrl.endsWith("/internal/packages/report")) {
      const { proxyToken: _redacted, ...reported } = body;
      input.reports.push(reported);
      return json({ ok: true });
    }
    if (textUrl.endsWith("/internal/egress/authorize")) {
      const allowed = body.host === "registry.npmjs.org";
      return json({ ok: true, allowed, reason: allowed ? "allowed" : "not_declared_for_session" });
    }
    if (textUrl.endsWith("/internal/egress/report")) {
      const { proxyToken: _redacted, ...reported } = body;
      input.reports.push(reported);
      return json({ ok: true });
    }
    if (textUrl.startsWith("https://registry.npmjs.org/")) {
      return input.onUpstream(textUrl);
    }
    if (textUrl.startsWith("https://evil.test/")) {
      return input.onUpstream(textUrl);
    }
    return new Response("unexpected fetch", { status: 500 });
  }) as typeof fetch;
}

async function connectThroughProxy(input: {
  readonly proxyPort: number;
  readonly targetHost?: string;
  readonly targetPort: number;
  readonly token: string;
}): Promise<string> {
  const credentials = Buffer.from(`${encodeProxyIdentity("project_a", "session_1")}:${input.token}`, "utf8").toString("base64");
  const targetHost = input.targetHost ?? "github.com";
  return rawProxyRequest(
    input.proxyPort,
    [
      `CONNECT ${targetHost}:${input.targetPort} HTTP/1.1`,
      `host: ${targetHost}:${input.targetPort}`,
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

async function packageProxyRequest(port: number, packageName: string, token: string): Promise<string> {
  const credentials = Buffer.from(`${encodeProxyIdentity("project_a", "session_1")}:${token}`, "utf8").toString("base64");
  const encodedPackage = encodeURIComponent(packageName);
  return rawProxyRequest(
    port,
    [
      `GET /package/npm/registry.npmjs.org/${encodedPackage} HTTP/1.1`,
      "host: 127.0.0.1",
      `authorization: Basic ${credentials}`,
      "connection: close",
      "",
      "",
    ].join("\r\n"),
  );
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

function publicResolver(address = "93.184.216.34"): () => Promise<readonly string[]> {
  return async () => [address];
}

function testPort(): number {
  return 39_000 + Math.floor(Math.random() * 1000);
}
