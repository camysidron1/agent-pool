import { describe, expect, test } from "bun:test";
import { generateKeyPairSync } from "node:crypto";

import { createGitHubAppTokenBroker, parseGitHubRepository, signGitHubAppJwt } from "../src/github-token-broker";

describe("GitHub App token broker", () => {
  test("parses and normalizes HTTPS GitHub repository URLs only", () => {
    expect(parseGitHubRepository("https://github.com/example/tiny-fixture.git")).toEqual({
      name: "tiny-fixture",
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
    });
    expect(parseGitHubRepository("https://github.com/example/tiny-fixture")).toEqual({
      name: "tiny-fixture",
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
    });
    expect(() => parseGitHubRepository("git@github.com:example/tiny-fixture.git")).toThrow("https GitHub repository URL");
    expect(() => parseGitHubRepository("https://evil.example/example/tiny-fixture")).toThrow("https GitHub repository URL");
  });

  test("mints installation tokens scoped to contents and pull request writes", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const fetchCalls: Array<{ readonly url: string; readonly init: RequestInit }> = [];
    const broker = createGitHubAppTokenBroker({
      config: {
        appId: "12345",
        privateKey: privateKeyPem,
        installationId: "98765",
        apiBaseUrl: "https://api.github.test",
        tokenEnvName: "GITHUB_TOKEN",
        tokenTtlSeconds: 600,
        configured: true,
      },
      clock: { now: () => new Date("2026-05-14T18:00:00.000Z") },
      fetch: (async (url, init) => {
        fetchCalls.push({ url: String(url), init: init ?? {} });
        return new Response(JSON.stringify({ token: "installation-token", expires_at: "2026-05-14T18:10:00.000Z" }), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    await expect(broker.mintInstallationToken({ repositoryUrl: "https://github.com/example/tiny-fixture.git" })).resolves.toEqual({
      ok: true,
      token: {
        envName: "GITHUB_TOKEN",
        value: "installation-token",
        expiresAt: "2026-05-14T18:10:00.000Z",
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
      },
    });

    expect(fetchCalls).toHaveLength(1);
    expect(fetchCalls[0]?.url).toBe("https://api.github.test/app/installations/98765/access_tokens");
    expect(fetchCalls[0]?.init.headers).toMatchObject({
      accept: "application/vnd.github+json",
      "content-type": "application/json",
      "x-github-api-version": "2022-11-28",
    });
    expect(String((fetchCalls[0]?.init.headers as Record<string, string>).authorization)).toMatch(/^Bearer /);
    expect(JSON.parse(String(fetchCalls[0]?.init.body))).toEqual({
      repositories: ["tiny-fixture"],
      permissions: {
        contents: "write",
        pull_requests: "write",
      },
    });
  });

  test("signs bounded GitHub App JWTs without embedding the private key", () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const privateKeyPem = privateKey.export({ type: "pkcs1", format: "pem" }).toString();
    const jwt = signGitHubAppJwt({
      appId: "12345",
      privateKey: privateKeyPem,
      now: new Date("2026-05-14T18:00:00.000Z"),
      ttlSeconds: 600,
    });
    const parts = jwt.split(".");

    expect(parts).toHaveLength(3);
    expect(JSON.parse(Buffer.from(parts[0] ?? "", "base64url").toString("utf8"))).toEqual({ alg: "RS256", typ: "JWT" });
    expect(JSON.parse(Buffer.from(parts[1] ?? "", "base64url").toString("utf8"))).toEqual({
      iat: 1778781540,
      exp: 1778782140,
      iss: "12345",
    });
    expect(jwt).not.toContain("PRIVATE KEY");
  });
});
