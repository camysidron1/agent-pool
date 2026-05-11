import { describe, expect, test } from "bun:test";

import { DEFAULT_SERVICE_TOKEN, DEFAULT_SERVICE_TOKEN_HEADER, loadConfig } from "@agent-pool/config";

import { createServiceTokenHeaders, verifyServiceTokenHeader, verifyServiceTokenValue } from "../src";

describe("service-token auth", () => {
  test("creates deterministic service-token headers", () => {
    const config = loadConfig({ AUTH_MODE: "test" }).serviceToken;

    expect(createServiceTokenHeaders(config)).toEqual({
      [DEFAULT_SERVICE_TOKEN_HEADER]: DEFAULT_SERVICE_TOKEN,
    });
  });

  test("verifies service-token header values", () => {
    const config = loadConfig({ AUTH_MODE: "test" }).serviceToken;
    const headers = new Headers(createServiceTokenHeaders(config));

    expect(verifyServiceTokenHeader(headers, config)).toEqual({ ok: true, subject: "internal-service" });
    expect(verifyServiceTokenValue(DEFAULT_SERVICE_TOKEN, config)).toEqual({ ok: true, subject: "internal-service" });
    expect(verifyServiceTokenValue(undefined, config)).toEqual({ ok: false, reason: "missing" });
    expect(verifyServiceTokenValue("wrong", config)).toEqual({ ok: false, reason: "invalid" });
  });
});
