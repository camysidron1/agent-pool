import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { lookup as dnsLookup } from "node:dns/promises";
import { connect as defaultConnectTcp, isIP, type Socket } from "node:net";
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
  readonly packageCache?: PackageProxyCache;
  readonly resolveHostAddresses?: EgressGatewayHostResolver;
  readonly connectTcp?: EgressGatewayTcpConnector;
};

export type EgressGatewayHostResolver = (host: string) => Promise<readonly string[]>;
export type EgressGatewayTcpConnector = (port: number, host: string) => Socket;

export type PackageProxyCacheEntry = {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Buffer;
};

export type PackageProxyCache = {
  readonly get: (key: string) => PackageProxyCacheEntry | undefined;
  readonly set: (key: string, value: PackageProxyCacheEntry) => void;
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
  const packageCache = options.packageCache ?? createInMemoryPackageProxyCache();
  const resolveHostAddresses = options.resolveHostAddresses ?? defaultResolveHostAddresses;
  const connectTcp = options.connectTcp ?? defaultConnectTcp;
  const server = createServer((request, response) => {
    if (request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ ok: true, service: "agent-pool-egress-gateway" }));
      return;
    }
    if (isPackageProxyRequest(request.url)) {
      handlePackageProxyRequest({ request, response, options, fetchImpl, logger, packageCache, resolveHostAddresses }).catch((error) => {
        logger({ level: "error", event: "package.proxy.failed", errorMessage: errorMessage(error) });
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("package proxy failed\n");
      });
      return;
    }
    handleHttpProxyRequest({ request, response, options, fetchImpl, logger, resolveHostAddresses }).catch((error) => {
      logger({ level: "error", event: "egress.proxy.http_failed", errorMessage: errorMessage(error) });
      if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
      response.end("egress proxy failed\n");
    });
  });

  server.on("connect", (request, clientSocket, head) => {
    handleConnectProxyRequest({ request, clientSocket, head, options, fetchImpl, logger, resolveHostAddresses, connectTcp }).catch((error) => {
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

export function createInMemoryPackageProxyCache(): PackageProxyCache {
  const entries = new Map<string, PackageProxyCacheEntry>();
  return {
    get: (key) => entries.get(key),
    set: (key, value) => entries.set(key, value),
  };
}

async function handlePackageProxyRequest(input: {
  readonly request: IncomingMessage;
  readonly response: ServerResponse;
  readonly options: CreateEgressGatewayOptions;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
  readonly packageCache: PackageProxyCache;
  readonly resolveHostAddresses: EgressGatewayHostResolver;
}): Promise<void> {
  const target = parsePackageProxyTarget(input.request.url);
  const identity = readProxyIdentity(input.request.headers.authorization) ?? readProxyIdentity(input.request.headers["proxy-authorization"]);
  if (!target || !identity) {
    input.response.writeHead(407, { "content-type": "text/plain", "www-authenticate": "Basic realm=\"agent-pool-package-proxy\"" });
    input.response.end("package proxy authentication required\n");
    return;
  }
  const networkDecision = await validateNetworkTarget({
    host: target.registryHost,
    resolveHostAddresses: input.resolveHostAddresses,
  });
  if (!networkDecision.allowed) {
    await reportPackageResolution({
      config: input.options.config,
      fetchImpl: input.fetchImpl,
      identity,
      target,
      decision: "denied",
      reason: networkDecision.reason,
    });
    input.logger({ event: "package.proxy.denied", registryHost: target.registryHost, packageName: target.packageName, reason: networkDecision.reason });
    input.response.writeHead(403, { "content-type": "text/plain" });
    input.response.end(`${networkDecision.reason}\n`);
    return;
  }
  const decision = await authorizePackageRequest({
    config: input.options.config,
    fetchImpl: input.fetchImpl,
    identity,
    target,
  });
  if (!decision.allowed) {
    input.logger({ event: "package.proxy.denied", registryHost: target.registryHost, packageName: target.packageName, reason: decision.reason });
    input.response.writeHead(403, { "content-type": "text/plain" });
    input.response.end(`${decision.reason}\n`);
    return;
  }

  const cacheKey = `${input.request.method ?? "GET"} ${target.upstreamUrl}`;
  if ((input.request.method ?? "GET").toUpperCase() === "GET") {
    const cached = input.packageCache.get(cacheKey);
    if (cached) {
      input.logger({ event: "package.proxy.cache_hit", registryHost: target.registryHost, packageName: target.packageName });
      input.response.writeHead(cached.status, cached.headers);
      input.response.end(cached.body);
      return;
    }
  }

  input.logger({ event: "package.proxy.cache_miss", registryHost: target.registryHost, packageName: target.packageName });
  const upstream = await fetchPackageProxyUpstream({
    target,
    method: input.request.method ?? "GET",
    headers: stripProxyHeaders(input.request.headers),
    identity,
    config: input.options.config,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    resolveHostAddresses: input.resolveHostAddresses,
  });
  const body = Buffer.from(await upstream.arrayBuffer());
  const headers = safeResponseHeaders(upstream.headers);
  const packageMetadataDecision = inspectPackageMetadata({
    body,
    headers,
  });
  if (!packageMetadataDecision.allowed) {
    await reportPackageResolution({
      config: input.options.config,
      fetchImpl: input.fetchImpl,
      identity,
      target,
      decision: "denied",
      reason: packageMetadataDecision.reason,
    });
    input.logger({
      event: "package.proxy.denied",
      registryHost: target.registryHost,
      packageName: target.packageName,
      reason: packageMetadataDecision.reason,
    });
    input.response.writeHead(403, { "content-type": "text/plain" });
    input.response.end(`${packageMetadataDecision.reason}\n`);
    return;
  }
  const entry: PackageProxyCacheEntry = {
    status: upstream.status,
    headers,
    body,
  };
  if (!upstream.ok) {
    await reportPackageResolution({
      config: input.options.config,
      fetchImpl: input.fetchImpl,
      identity,
      target,
      decision: "failed",
      reason: `upstream_${upstream.status}`,
    });
  } else if ((input.request.method ?? "GET").toUpperCase() === "GET") {
    input.packageCache.set(cacheKey, entry);
  }
  input.response.writeHead(entry.status, entry.headers);
  input.response.end(entry.body);
}

async function handleConnectProxyRequest(input: {
  readonly request: IncomingMessage;
  readonly clientSocket: Duplex;
  readonly head: Buffer;
  readonly options: CreateEgressGatewayOptions;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
  readonly resolveHostAddresses: EgressGatewayHostResolver;
  readonly connectTcp: EgressGatewayTcpConnector;
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
    resolveHostAddresses: input.resolveHostAddresses,
  });
  if (!decision.allowed) {
    denyConnect(input.clientSocket, 403, decision.reason);
    return;
  }

  const upstream = input.connectTcp(target.port, target.host);
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
  readonly resolveHostAddresses: EgressGatewayHostResolver;
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
    resolveHostAddresses: input.resolveHostAddresses,
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
    async (upstreamResponse) => {
      const redirectDecision = await authorizeRedirectIfNeeded({
        currentUrl: target,
        location: upstreamResponse.headers.location,
        status: upstreamResponse.statusCode ?? 0,
        config: input.options.config,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
        identity,
        method: `${input.request.method ?? "GET"}_REDIRECT`,
        resolveHostAddresses: input.resolveHostAddresses,
      });
      if (!redirectDecision.allowed) {
        upstreamResponse.resume();
        input.response.writeHead(403, { "content-type": "text/plain" });
        input.response.end(`${redirectDecision.reason}\n`);
        return;
      }
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
  readonly resolveHostAddresses: EgressGatewayHostResolver;
}): Promise<EgressDecision> {
  const networkDecision = await validateNetworkTarget({
    host: input.host,
    resolveHostAddresses: input.resolveHostAddresses,
  });
  if (!networkDecision.allowed) {
    await reportEgressDecision({ ...input, host: normalizeHost(input.host), allowed: false, reason: networkDecision.reason });
    input.logger({ event: "egress.denied", host: normalizeHost(input.host), allowed: false, reason: networkDecision.reason });
    return networkDecision;
  }
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
  await reportEgressDecision({ ...input, host: body.host, allowed, reason });
  input.logger({ event: allowed ? "egress.allowed" : "egress.denied", host: body.host, allowed, reason });
  return { allowed, reason };
}

async function reportEgressDecision(input: {
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly identity: ProxyIdentity;
  readonly host: string;
  readonly port: number;
  readonly method: string;
  readonly allowed: boolean;
  readonly reason: string;
}): Promise<void> {
  const event = {
    projectId: input.identity.projectId,
    sessionId: input.identity.sessionId,
    proxyToken: input.identity.proxyToken,
    host: input.host,
    port: input.port,
    method: input.method,
    allowed: input.allowed,
    reason: input.reason,
  };
  await input.fetchImpl(`${input.config.egressGateway.backendInternalUrl}/internal/egress/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(input.config.serviceToken),
    },
    body: JSON.stringify(event),
  }).catch(() => undefined);
}

async function authorizeRedirectIfNeeded(input: {
  readonly currentUrl: URL;
  readonly location: string | string[] | undefined;
  readonly status: number;
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
  readonly identity: ProxyIdentity;
  readonly method: string;
  readonly resolveHostAddresses: EgressGatewayHostResolver;
}): Promise<EgressDecision> {
  if (!isRedirectResponse(input.status)) return { allowed: true, reason: "not_redirect" };
  const location = Array.isArray(input.location) ? input.location[0] : input.location;
  if (!location) return { allowed: true, reason: "redirect_without_location" };
  const nextUrl = new URL(location, input.currentUrl);
  if (normalizeHost(nextUrl.hostname) === normalizeHost(input.currentUrl.hostname)) {
    return { allowed: true, reason: "same_host_redirect" };
  }
  return authorizeAndReport({
    config: input.config,
    fetchImpl: input.fetchImpl,
    logger: input.logger,
    identity: input.identity,
    host: nextUrl.hostname,
    port: Number(nextUrl.port || (nextUrl.protocol === "https:" ? 443 : 80)),
    method: input.method,
    resolveHostAddresses: input.resolveHostAddresses,
  });
}

async function authorizePackageRequest(input: {
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly identity: ProxyIdentity;
  readonly target: PackageProxyTarget;
}): Promise<EgressDecision> {
  const response = await input.fetchImpl(`${input.config.egressGateway.backendInternalUrl}/internal/packages/authorize`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(input.config.serviceToken),
    },
    body: JSON.stringify({
      projectId: input.identity.projectId,
      sessionId: input.identity.sessionId,
      proxyToken: input.identity.proxyToken,
      registryHost: input.target.registryHost,
      packageName: input.target.packageName,
      ecosystem: input.target.ecosystem,
    }),
  });
  const result = (await response.json().catch(() => ({}))) as Readonly<Record<string, unknown>>;
  const allowed = response.ok && result.ok === true && result.allowed === true;
  const reason = typeof result.reason === "string" ? result.reason : allowed ? "allowed" : "denied";
  return { allowed, reason };
}

async function fetchPackageProxyUpstream(input: {
  readonly target: PackageProxyTarget;
  readonly method: string;
  readonly headers: Headers;
  readonly identity: ProxyIdentity;
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly logger: EgressGatewayLogger;
  readonly resolveHostAddresses: EgressGatewayHostResolver;
}): Promise<Response> {
  let url = input.target.upstreamUrl;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    const response = await input.fetchImpl(url, {
      method: input.method,
      headers: input.headers,
      redirect: "manual",
    });
    if (!isRedirectResponse(response.status)) return response;
    const location = response.headers.get("location");
    if (!location) return response;
    const nextUrl = new URL(location, url);
    const currentHost = new URL(url).hostname;
    if (normalizeHost(nextUrl.hostname) !== normalizeHost(currentHost)) {
      const decision = await authorizeAndReport({
        config: input.config,
        fetchImpl: input.fetchImpl,
        logger: input.logger,
        identity: input.identity,
        host: nextUrl.hostname,
        port: Number(nextUrl.port || (nextUrl.protocol === "https:" ? 443 : 80)),
        method: "PACKAGE_REDIRECT",
        resolveHostAddresses: input.resolveHostAddresses,
      });
      if (!decision.allowed) {
        await reportPackageResolution({
          config: input.config,
          fetchImpl: input.fetchImpl,
          identity: input.identity,
          target: input.target,
          decision: "denied",
          reason: `redirect_${decision.reason}`,
        });
        return new Response(`redirect_${decision.reason}\n`, { status: 403, headers: { "content-type": "text/plain" } });
      }
    }
    url = nextUrl.toString();
  }
  return new Response("redirect_limit_exceeded\n", { status: 508, headers: { "content-type": "text/plain" } });
}

async function reportPackageResolution(input: {
  readonly config: AppConfig;
  readonly fetchImpl: typeof fetch;
  readonly identity: ProxyIdentity;
  readonly target: PackageProxyTarget;
  readonly decision: "allowed" | "denied" | "failed";
  readonly reason: string;
}): Promise<void> {
  await input.fetchImpl(`${input.config.egressGateway.backendInternalUrl}/internal/packages/report`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...createServiceTokenHeaders(input.config.serviceToken),
    },
    body: JSON.stringify({
      projectId: input.identity.projectId,
      sessionId: input.identity.sessionId,
      proxyToken: input.identity.proxyToken,
      registryHost: input.target.registryHost,
      packageName: input.target.packageName,
      ecosystem: input.target.ecosystem,
      decision: input.decision,
      reason: input.reason,
    }),
  }).catch(() => undefined);
}

type PackageProxyTarget = {
  readonly ecosystem: "npm";
  readonly registryHost: string;
  readonly packageName: string;
  readonly upstreamUrl: string;
};

function isPackageProxyRequest(value: string | undefined): boolean {
  return Boolean(value?.startsWith("/package/"));
}

function parsePackageProxyTarget(value: string | undefined): PackageProxyTarget | null {
  if (!value) return null;
  const url = new URL(value, "http://agent-pool-egress-gateway.local");
  const prefix = "/package/npm/";
  if (!url.pathname.startsWith(prefix)) return null;
  const rest = url.pathname.slice(prefix.length);
  const separator = rest.indexOf("/");
  if (separator < 1) return null;
  const registryHost = normalizeHost(decodeURIComponent(rest.slice(0, separator)));
  const packagePath = decodeURIComponent(rest.slice(separator + 1)).replace(/^\/+/, "");
  const packageName = readPackageNameFromPath(packagePath);
  if (!packageName) return null;
  return {
    ecosystem: "npm",
    registryHost,
    packageName,
    upstreamUrl: `https://${registryHost}/${packagePath}${url.search}`,
  };
}

function readPackageNameFromPath(path: string): string | null {
  if (!path || path.includes("..") || path.includes("\\")) return null;
  const parts = path.split("/").filter(Boolean);
  if (parts.length === 0) return null;
  if (parts[0]?.startsWith("@")) {
    return parts.length >= 2 ? `${parts[0].toLowerCase()}/${parts[1]?.toLowerCase()}` : null;
  }
  return parts[0]?.toLowerCase() ?? null;
}

function stripProxyHeaders(headers: IncomingMessage["headers"]): Headers {
  const output = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (!value || key.toLowerCase() === "authorization" || key.toLowerCase() === "proxy-authorization" || key.toLowerCase() === "proxy-connection") {
      continue;
    }
    if (Array.isArray(value)) {
      for (const item of value) output.append(key, item);
    } else {
      output.set(key, value);
    }
  }
  return output;
}

function safeResponseHeaders(headers: Headers): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const [key, value] of headers.entries()) {
    const lower = key.toLowerCase();
    if (lower === "set-cookie" || lower === "www-authenticate" || lower === "proxy-authenticate") continue;
    if (["content-type", "etag", "cache-control", "last-modified"].includes(lower)) {
      output[lower] = value;
    }
  }
  return output;
}

function inspectPackageMetadata(input: {
  readonly body: Buffer;
  readonly headers: Readonly<Record<string, string>>;
}): EgressDecision {
  const contentType = input.headers["content-type"] ?? "";
  const text = input.body.toString("utf8").trim();
  if (!text.startsWith("{") && !contentType.includes("json")) return { allowed: true, reason: "not_package_metadata" };
  try {
    const metadata = JSON.parse(text) as unknown;
    return hasLifecycleScript(metadata) ? { allowed: false, reason: "package_lifecycle_script_forbidden" } : { allowed: true, reason: "no_lifecycle_scripts" };
  } catch {
    return { allowed: true, reason: "unparsed_package_metadata" };
  }
}

function hasLifecycleScript(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Readonly<Record<string, unknown>>;
  if (hasForbiddenScriptMap(record.scripts)) return true;
  const versions = record.versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) return false;
  return Object.values(versions).some((version) => version && typeof version === "object" && !Array.isArray(version) && hasForbiddenScriptMap((version as Record<string, unknown>).scripts));
}

function hasForbiddenScriptMap(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scripts = value as Readonly<Record<string, unknown>>;
  return ["preinstall", "install", "postinstall", "prepare"].some((name) => typeof scripts[name] === "string" && scripts[name].trim().length > 0);
}

async function validateNetworkTarget(input: {
  readonly host: string;
  readonly resolveHostAddresses: EgressGatewayHostResolver;
}): Promise<EgressDecision> {
  const host = normalizeHost(stripHostBrackets(input.host));
  const syntaxError = validateHostSyntax(host);
  if (syntaxError) return { allowed: false, reason: syntaxError };
  if (isBlockedHostname(host)) return { allowed: false, reason: "blocked_hostname" };
  if (isIP(host)) return { allowed: false, reason: "ip_literal_forbidden" };
  let addresses: readonly string[];
  try {
    addresses = await input.resolveHostAddresses(host);
  } catch {
    return { allowed: false, reason: "dns_resolution_failed" };
  }
  if (addresses.length === 0) return { allowed: false, reason: "dns_no_addresses" };
  if (addresses.some((address) => !isPublicIpAddress(address))) {
    return { allowed: false, reason: "dns_target_not_public" };
  }
  return { allowed: true, reason: "network_target_public" };
}

function validateHostSyntax(host: string): string | null {
  if (!host || host.length > 253 || /[\s/:\\]/.test(host)) return "invalid_host";
  if (host.endsWith(".")) return "invalid_host";
  const labels = host.split(".");
  if (labels.length < 2) return "invalid_host";
  for (const label of labels) {
    if (!label || label.length > 63 || !/^[a-z0-9-]+$/.test(label) || label.startsWith("-") || label.endsWith("-")) {
      return "invalid_host";
    }
  }
  return null;
}

function isBlockedHostname(host: string): boolean {
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host === "metadata" ||
    host === "metadata.google.internal" ||
    host.endsWith(".metadata.google.internal")
  );
}

function isPublicIpAddress(address: string): boolean {
  const normalized = stripHostBrackets(address).toLowerCase();
  if (isIPv4Address(normalized)) return isPublicIPv4Address(normalized);
  if (normalized.startsWith("::ffff:")) {
    const mapped = normalized.slice("::ffff:".length);
    if (isIPv4Address(mapped)) return isPublicIPv4Address(mapped);
  }
  return isPublicIPv6Address(normalized);
}

function isIPv4Address(address: string): boolean {
  return /^\d{1,3}(\.\d{1,3}){3}$/.test(address);
}

function isPublicIPv4Address(address: string): boolean {
  const parts = address.split(".").map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a = 0, b = 0, c = 0] = parts;
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0 && c === 0) return false;
  if (a === 192 && b === 0 && c === 2) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  if (a >= 224) return false;
  return true;
}

function isPublicIPv6Address(address: string): boolean {
  const normalized = address.toLowerCase();
  if (normalized === "::" || normalized === "::1") return false;
  if (normalized.startsWith("fe8") || normalized.startsWith("fe9") || normalized.startsWith("fea") || normalized.startsWith("feb")) return false;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8")) return false;
  return isIP(normalized) === 6;
}

function stripHostBrackets(value: string): string {
  const trimmed = value.trim().toLowerCase();
  return trimmed.startsWith("[") && trimmed.endsWith("]") ? trimmed.slice(1, -1) : trimmed;
}

async function defaultResolveHostAddresses(host: string): Promise<readonly string[]> {
  const records = await dnsLookup(host, { all: true, verbatim: true });
  return records.map((record) => record.address);
}

function isRedirectResponse(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308;
}

function parseConnectTarget(value: string | undefined): { readonly host: string; readonly port: number } | null {
  const raw = value?.trim();
  if (!raw) return null;
  if (raw.includes("/") || /\s/.test(raw)) return null;
  const separator = raw.lastIndexOf(":");
  if (separator <= 0 || separator === raw.length - 1) return null;
  const host = raw.slice(0, separator);
  const portText = raw.slice(separator + 1);
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
