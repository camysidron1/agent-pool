import { describe, expect, test } from "bun:test";

import { ConfigError, TEST_OPERATOR_IDENTITY, loadConfig } from "../src";

describe("loadConfig", () => {
  test("uses deterministic operator identity in test auth mode", () => {
    expect(loadConfig({ AUTH_MODE: "test" }).operator).toEqual(TEST_OPERATOR_IDENTITY);
  });

  test("rejects missing required env in non-test auth mode", () => {
    expect(() => loadConfig({ AUTH_MODE: "local" })).toThrow(ConfigError);
  });

  test("loads explicit operator identity in non-test auth mode", () => {
    expect(
      loadConfig({
        AUTH_MODE: "local",
        OPERATOR_ID: "operator-1",
        OPERATOR_EMAIL: "operator@example.com",
      }),
    ).toEqual({
      authMode: "local",
      operator: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "operator@example.com",
      },
    });
  });
});
