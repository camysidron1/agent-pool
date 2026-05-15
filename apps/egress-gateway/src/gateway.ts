import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { connect as connectTcp, type Socket } from "node:net";
import type { Duplex } from "node:stream";
import { pipeline } from "node:stream";

import { createServiceTokenHeaders } from "@agent-pool/auth";
import type { AppConfig } from "@agent-pool/config";

export type EgressGatewayLogger = (event: Readonly<Record<string, unknown>>) => void;

export type EgressGatewayServer = {
  readonly listen: (port?: number, hostname?: string) => Promise<void>;
  readonly close: () => Promise<void>;
};

export type CreateEgressGatewayOptions = {
  readonly config: AppConfig;
  readonly fetch?: typeof fetch;
  readonly logger?: EgressGatewayLogger;
};

type ProxyIdentity = {
  readonly projectId: string;
  readonly sessionId: string;
  readonly proxyToken: string;
};

type EgressDecision = {
  readonly allowed: boolean;
  readonly reason: string;
};

export function createEgressGateway(options: CreateEgressGatewayOptions): EgressGatewayServer {
  const fetchImpl = options.fetch ?? fetch;
  const logger = options.logger ?? ((event) => console.log(JSON.stringify(event)));
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "agent-pool-egress-gateway" }));
      return;
    }
    handleHttpProxyRequest({ request, response, options, fetchImpl, logger }).catch((error) => {
      logger({ level: "error", event: "egress.proxy.http_failed", errorMessage: errorMessage(error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("egress proxy failed\n");
    });
  });

  server.on("connect", (request, clientSocket, head) => {
    handleConnectProxyRequest({ request, clientSocket, head, options, fetchImpl, logger }).catch((error) => {
      logger({ level: "error", event: "egress.proxy.connect_failed", errorMessage: errorMessage(error) });
      denyConnect(clientSocket, 502, "egress proxy failed");
    });
  });

  return {
    listen(port = options.config.egressGateway.port, hostname = "0.0.0.0"): Promise<void> {
      return new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(port, hostname, () => {
          server.off("error", reject);
          logger({ event: "egress.gateway.listening", port, hostname });
          resolve();
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

export function encodeProxyIdentity(projectId: string, sessionId: string): string {
  return Buffer.from(`${projectId}:${sessionId}`, "utf8").toString("base64url");
}

async function handleConnectProxyRequest(input: {
  readonly request: IncomingMessage;
  readonly clientSocket: Duplex;
  readonly head: Buffer;
  readonly options: CreateEgressGatewayOptions;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
}): Promise<void> {
  const target = parseConnectTarget(input.request.url);
  const identity = readProxyIdentity(input.request.headers["proxy-authorization"]);
  if (!target || !identity) {
    denyConnect(input.clientSocket, 407, "proxy authentication required");
    return;
  }

  const decision = await authorizeAndReport({
    config: input.options.config,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    identity,
    host: target.host,
    port: target.port,
    method: "CONNECT",
  });
  if (!decision.allowed) {
    denyConnect(input.clientSocket, 403, decision.reason);
    return;
  }

  const upstream = connectTcp(target.port, target.host);
  upstream.once("connect", () => {
    input.clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
    if (input.head.length > 0) upstream.write(input.head);
    input.clientSocket.pipe(upstream);
    upstream.pipe(input.clientSocket);
  });
  upstream.once("error", () => {
    denyConnect(input.clientSocket, 502, "upstream connection failed");
  });
}

async function handleHttpProxyRequest(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly options: CreateEgressGatewayOptions;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
}): Promise<void> {
  const target = parseHttpProxyTarget(input.request.url);
  const identity = readProxyIdentity(input.request.headers["proxy-authorization"]);
  if (!target || !identity) {
    input.response.writeHead(407, { "content-type": "text/plain", "proxy-authenticate": "Basic realm=\"agent-pool-egress\"" });
    input.response.end("proxy authentication required\n");
    return;
  }

  const decision = await authorizeAndReport({
    config: input.options.config,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    identity,
    host: target.hostname,
    port: Number(target.port || (target.protocol === "https:" ? 443 : 80)),
    method: input.request.method ?? "GET",
  });
  if (!decision.allowed) {
    input.response.writeHead(403, { "content-type": "text/plain" });
    input.response.end(`${decision.reason}\n`);
    return;
  }

  const headers = { ...input.request.headers };
  delete headers["proxy-authorization"];
  delete headers["proxy-connection"];
  const upstream = httpRequest(
    target,
    {
      method: input.request.method,
      headers,
    },
    (upstreamResponse) => {
      input.response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
      pipeline(upstreamResponse, input.response, () => undefined);
    },
  );
  upstream.on("error", () => {
    if (!input.response.headersSent) input.response.writeHead(502, { "content-type": "text/plain" });
    input.response.end("upstream request failed\n");
  });
  pipeline(input.request, upstream, () => undefined);
}

async function authorizeAndReport(input: {
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
  readonly identity: ProxyIdentity;
  readonly host: string;
  readonly port: number;
  readonly method: string;
}): Promise<EgressDecision> {
  const body = {
    projectId: input.identity.projectId,
    sessionId: input.identity.sessionId,
    proxyToken: input.identity.proxyToken,
    host: normalizeHost(input.host),
  };
  const response = await input.fetchImpl(`${input.config.egressGateway.backendInternalUrl}/internal/egress/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(input.config.serviceToken),
    },
    body: JSON.stringify(body),
  });
  const result = (await response.json().catch(() => ({}))) as Readonly<Record<string, unknown>>;
  const allowed = response.ok && result.ok === true && result.allowed === true;
  const reason = typeof result.reason === "string" ? result.reason : allowed ? "allowed" : "denied";
  const event = {
    projectId: input.identity.projectId,
    sessionId: input.identity.sessionId,
    proxyToken: input.identity.proxyToken,
    host: body.host,
    port: input.port,
    method: input.method,
    allowed,
    reason,
  };
  await input.fetchImpl(`${input.config.egressGateway.backendInternalUrl}/internal/egress/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(input.config.serviceToken),
    },
    body: JSON.stringify(event),
  }).catch(() => undefined);
  input.logger({ event: allowed ? "egress.allowed" : "egress.denied", host: body.host, allowed, reason });
  return { allowed, reason };
}

function parseConnectTarget(value: string | undefined): { readonly host: string; readonly port: number } | null {
  const raw = value?.trim();
  if (!raw) return null;
  const [host, portText] = raw.split(":");
  const port = Number(portText);
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { host: normalizeHost(host), port };
}

function parseHttpProxyTarget(value: string | undefined): URL | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function readProxyIdentity(value: string | string[] | undefined): ProxyIdentity | null {
  const header = Array.isArray(value) ? value[0] : value;
  const match = header?.match(/^Basic\s+(.+)$/i);
  if (!match) return null;
  const decoded = Buffer.from(match[1] ?? "", "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  if (separator < 1) return null;
  const encodedScope = decoded.slice(0, separator);
  const proxyToken = decoded.slice(separator + 1);
  const [projectId, sessionId] = Buffer.from(encodedScope, "base64url").toString("utf8").split(":");
  if (!projectId || !sessionId || !proxyToken) return null;
  return { projectId, sessionId, proxyToken };
}

function denyConnect(socket: Duplex, status: number, reason: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${reason}\r\ncontent-length: 0\r\n\r\n`);
  socket.destroy();
}

function normalizeHost(value: string): string {
  return value.toLowerCase().replace(/\.$/, "");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
