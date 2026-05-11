import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  DEFAULT_BACKEND_INTERNAL_URL,
  DEFAULT_ORCHESTRATOR_URL,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_SERVICE_TOKEN,
  DEFAULT_SERVICE_TOKEN_HEADER,
  DEFAULT_STORAGE_LOCAL_ROOT,
  TEST_OPERATOR_IDENTITY,
  loadConfig,
} from "../src";

describe("loadConfig", () => {
  test("uses deterministic operator and control-plane defaults in test auth mode", () => {
    expect(loadConfig({ AUTH_MODE: "test" })).toEqual({
      authMode: "test",
      operator: TEST_OPERATOR_IDENTITY,
      serviceToken: {
        token: DEFAULT_SERVICE_TOKEN,
        headerName: DEFAULT_SERVICE_TOKEN_HEADER,
      },
      backend: {
        port: 3000,
        publicUrl: DEFAULT_BACKEND_INTERNAL_URL,
        internalUrl: DEFAULT_BACKEND_INTERNAL_URL,
      },
      orchestrator: {
        port: 3001,
        publicUrl: DEFAULT_ORCHESTRATOR_URL,
        backendInternalUrl: DEFAULT_BACKEND_INTERNAL_URL,
      },
      rabbitmq: {
        url: DEFAULT_RABBITMQ_URL,
        projectTaskQueuePrefix: "project-tasks",
        projectControlQueuePrefix: "project-control",
      },
      storage: {
        adapter: "local",
        localRoot: DEFAULT_STORAGE_LOCAL_ROOT,
        bucket: "agent-pool-web-sandbox",
      },
    });
  });

  test("rejects missing required env in non-test auth mode", () => {
    expect(() => loadConfig({ AUTH_MODE: "local" })).toThrow(ConfigError);
  });

  test("requires service token in non-test auth mode", () => {
    expect(() =>
      loadConfig({
        AUTH_MODE: "local",
        OPERATOR_ID: "operator-1",
        OPERATOR_EMAIL: "operator@example.com",
      }),
    ).toThrow("INTERNAL_SERVICE_TOKEN is required");
  });

  test("loads explicit control-plane config in non-test auth mode", () => {
    expect(
      loadConfig({
        AUTH_MODE: "local",
        OPERATOR_ID: "operator-1",
        OPERATOR_EMAIL: "operator@example.com",
        INTERNAL_SERVICE_TOKEN: "secret-token",
        API_PORT: "4100",
        API_PUBLIC_URL: "http://api.local.test:4100/",
        API_INTERNAL_URL: "http://api.internal.test:4100/",
        ORCHESTRATOR_PORT: "4101",
        ORCHESTRATOR_PUBLIC_URL: "http://orchestrator.local.test:4101/",
        ORCHESTRATOR_BACKEND_INTERNAL_URL: "http://api.internal.test:4100/",
        RABBITMQ_URL: "amqp://rabbitmq.local.test:5672",
        RABBITMQ_PROJECT_TASK_QUEUE_PREFIX: "tasks",
        RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX: "control",
        STORAGE_ADAPTER: "blob",
        STORAGE_LOCAL_ROOT: "/tmp/agent-pool-storage",
        STORAGE_BUCKET: "agent-pool-test-bucket",
      }),
    ).toEqual({
      authMode: "local",
      operator: {
        id: "operator-1",
        email: "operator@example.com",
        displayName: "operator@example.com",
      },
      serviceToken: {
        token: "secret-token",
        headerName: DEFAULT_SERVICE_TOKEN_HEADER,
      },
      backend: {
        port: 4100,
        publicUrl: "http://api.local.test:4100",
        internalUrl: "http://api.internal.test:4100",
      },
      orchestrator: {
        port: 4101,
        publicUrl: "http://orchestrator.local.test:4101",
        backendInternalUrl: "http://api.internal.test:4100",
      },
      rabbitmq: {
        url: "amqp://rabbitmq.local.test:5672",
        projectTaskQueuePrefix: "tasks",
        projectControlQueuePrefix: "control",
      },
      storage: {
        adapter: "blob",
        localRoot: "/tmp/agent-pool-storage",
        bucket: "agent-pool-test-bucket",
      },
    });
  });

  test("rejects invalid ports, URLs, and storage adapters", () => {
    expect(() => loadConfig({ AUTH_MODE: "test", API_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", RABBITMQ_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", STORAGE_ADAPTER: "s3" })).toThrow(ConfigError);
  });
});
