import { createSign } from "node:crypto";

import type { GitHubAppConfig } from "@agent-pool/config";

export type GitHubInstallationTokenRequest = {
  readonly repositoryUrl: string;
};

export type GitHubInstallationTokenResult =
  | {
      readonly ok: true;
      readonly token: {
        readonly envName: string;
        readonly value: string;
        readonly expiresAt: string | null;
        readonly repositoryUrl: string;
      };
    }
  | { readonly ok: false; readonly status: number; readonly error: string };

export type GitHubInstallationVerificationResult =
  | {
      readonly ok: true;
      readonly repositoryUrl: string;
      readonly token: {
        readonly envName: string;
        readonly expiresAt: string | null;
      };
      readonly permissions: {
        readonly contents: "write";
        readonly pull_requests: "write";
      };
    }
  | {
      readonly ok: false;
      readonly status: number;
      readonly error: string;
      readonly repositoryUrl?: string;
      readonly missingPermissions?: readonly string[];
    };

export type GitHubTokenBroker = {
  readonly mintInstallationToken: (input: GitHubInstallationTokenRequest) => Promise<GitHubInstallationTokenResult>;
  readonly verifyInstallationAccess?: (input: GitHubInstallationTokenRequest) => Promise<GitHubInstallationVerificationResult>;
};

export type CreateGitHubAppTokenBrokerOptions = {
  readonly config: GitHubAppConfig;
  readonly fetch?: typeof fetch;
  readonly clock?: { readonly now: () => Date };
};

type GitHubAccessTokenResponse = {
  readonly token?: unknown;
  readonly expires_at?: unknown;
  readonly permissions?: unknown;
};

export function createGitHubAppTokenBroker(options: CreateGitHubAppTokenBrokerOptions): GitHubTokenBroker {
  const fetchImpl = options.fetch ?? fetch;
  const clock = options.clock ?? { now: () => new Date() };

  return {
    async mintInstallationToken(input): Promise<GitHubInstallationTokenResult> {
      const result = await requestGitHubInstallationToken(options.config, input, fetchImpl, clock);
      if (!result.ok) return result;

      return {
        ok: true,
        token: {
          envName: options.config.tokenEnvName,
          value: result.token,
          expiresAt: result.expiresAt,
          repositoryUrl: result.repositoryUrl,
        },
      };
    },
    async verifyInstallationAccess(input): Promise<GitHubInstallationVerificationResult> {
      const result = await requestGitHubInstallationToken(options.config, input, fetchImpl, clock);
      if (!result.ok) return result;

      const permissions = readTokenPermissions(result.body.permissions);
      if (!permissions) {
        return {
          ok: false,
          status: 502,
          error: "github_token_response_missing_permissions",
          repositoryUrl: result.repositoryUrl,
        };
      }
      const missingPermissions = [
        ...(permissions.contents === "write" ? [] : ["contents:write"]),
        ...(permissions.pull_requests === "write" ? [] : ["pull_requests:write"]),
      ];
      if (missingPermissions.length > 0) {
        return {
          ok: false,
          status: 403,
          error: "github_app_permissions_insufficient",
          repositoryUrl: result.repositoryUrl,
          missingPermissions,
        };
      }

      return {
        ok: true,
        repositoryUrl: result.repositoryUrl,
        token: {
          envName: options.config.tokenEnvName,
          expiresAt: result.expiresAt,
        },
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
      };
    },
  };
}

async function requestGitHubInstallationToken(
  config: GitHubAppConfig,
  input: GitHubInstallationTokenRequest,
  fetchImpl: typeof fetch,
  clock: { readonly now: () => Date },
): Promise<
  | {
      readonly ok: true;
      readonly token: string;
      readonly expiresAt: string | null;
      readonly repositoryUrl: string;
      readonly body: GitHubAccessTokenResponse;
    }
  | { readonly ok: false; readonly status: number; readonly error: string; readonly repositoryUrl?: string }
> {
  if (!config.configured || !config.appId || !config.privateKey || !config.installationId) {
    return { ok: false, status: 503, error: "github_app_not_configured" };
  }

  let repo;
  try {
    repo = parseGitHubRepository(input.repositoryUrl);
  } catch (error) {
    return { ok: false, status: 400, error: errorMessage(error) };
  }

  const jwt = signGitHubAppJwt({
    appId: config.appId,
    privateKey: config.privateKey,
    now: clock.now(),
    ttlSeconds: Math.min(config.tokenTtlSeconds, 600),
  });
  const response = await fetchImpl(
    `${config.apiBaseUrl}/app/installations/${encodeURIComponent(config.installationId)}/access_tokens`,
    {
      method: "POST",
      headers: {
        accept: "application/vnd.github+json",
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
        "x-github-api-version": "2022-11-28",
      },
      body: JSON.stringify({
        repositories: [repo.name],
        permissions: {
          contents: "write",
          pull_requests: "write",
        },
      }),
    },
  );

  const body = (await response.json().catch(() => ({}))) as GitHubAccessTokenResponse;
  if (!response.ok) {
    return { ok: false, status: response.status, error: readGitHubError(body, response.status), repositoryUrl: repo.repositoryUrl };
  }
  if (typeof body.token !== "string" || !body.token.trim()) {
    return { ok: false, status: 502, error: "github_token_response_missing_token", repositoryUrl: repo.repositoryUrl };
  }

  return {
    ok: true,
    token: body.token,
    expiresAt: typeof body.expires_at === "string" && body.expires_at.trim() ? body.expires_at : null,
    repositoryUrl: repo.repositoryUrl,
    body,
  };
}

export function signGitHubAppJwt(input: {
  readonly appId: string;
  readonly privateKey: string;
  readonly now: Date;
  readonly ttlSeconds: number;
}): string {
  const iat = Math.floor(input.now.getTime() / 1000) - 60;
  const exp = iat + Math.min(Math.max(input.ttlSeconds, 60), 600);
  const header = base64UrlJson({ alg: "RS256", typ: "JWT" });
  const payload = base64UrlJson({ iat, exp, iss: input.appId });
  const signingInput = `${header}.${payload}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(input.privateKey, "base64url");

  return `${signingInput}.${signature}`;
}

export function parseGitHubRepository(repositoryUrl: string): { readonly name: string; readonly repositoryUrl: string } {
  let url: URL;
  try {
    url = new URL(repositoryUrl);
  } catch {
    throw new Error("repositoryUrl must be an https GitHub repository URL");
  }

  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (url.protocol !== "https:" || url.hostname !== "github.com" || parts.length !== 2) {
    throw new Error("repositoryUrl must be an https GitHub repository URL");
  }
  const owner = parts[0]?.trim();
  const repo = parts[1]?.replace(/\.git$/, "").trim();
  if (!owner || !repo || !/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) {
    throw new Error("repositoryUrl must be an https GitHub repository URL");
  }

  return {
    name: repo,
    repositoryUrl: `https://github.com/${owner}/${repo}.git`,
  };
}

function base64UrlJson(value: Readonly<Record<string, unknown>>): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function readGitHubError(body: GitHubAccessTokenResponse, status: number): string {
  const record = body as Readonly<Record<string, unknown>>;
  if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
  return `github_token_request_failed_${status}`;
}

function readTokenPermissions(value: unknown): { readonly contents: string | null; readonly pull_requests: string | null } | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Readonly<Record<string, unknown>>;
  return {
    contents: typeof record.contents === "string" ? record.contents : null,
    pull_requests: typeof record.pull_requests === "string" ? record.pull_requests : null,
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
