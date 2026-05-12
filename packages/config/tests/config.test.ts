import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  DEFAULT_BACKEND_INTERNAL_URL,
  DEFAULT_BRIDGE_SESSION_TOKEN_HEADER,
  DEFAULT_CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS,
  DEFAULT_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
  DEFAULT_CONTROL_PLANE_SMOKE_PROJECT_ID,
  DEFAULT_CONTROL_PLANE_WORKER_POLL_INTERVAL_MS,
  DEFAULT_ORCHESTRATOR_URL,
  DEFAULT_RABBITMQ_MANAGEMENT_URL,
  DEFAULT_RABBITMQ_URL,
  DEFAULT_RUNTIME_PROVIDER,
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
      bridge: {
        callbackBaseUrl: DEFAULT_BACKEND_INTERNAL_URL,
        sessionTokenHeaderName: DEFAULT_BRIDGE_SESSION_TOKEN_HEADER,
      },
      orchestrator: {
        port: 3001,
        publicUrl: DEFAULT_ORCHESTRATOR_URL,
        backendInternalUrl: DEFAULT_BACKEND_INTERNAL_URL,
      },
      rabbitmq: {
        url: DEFAULT_RABBITMQ_URL,
        managementUrl: DEFAULT_RABBITMQ_MANAGEMENT_URL,
        projectTaskQueuePrefix: "project-tasks",
        projectControlQueuePrefix: "project-control",
      },
      storage: {
        adapter: "local",
        localRoot: DEFAULT_STORAGE_LOCAL_ROOT,
        bucket: "agent-pool-web-sandbox",
      },
      controlPlane: {
        runtimeProvider: DEFAULT_RUNTIME_PROVIDER,
        smokeEnabled: true,
        smokeProjectId: DEFAULT_CONTROL_PLANE_SMOKE_PROJECT_ID,
        workerPollIntervalMs: DEFAULT_CONTROL_PLANE_WORKER_POLL_INTERVAL_MS,
        outboxPublishIntervalMs: DEFAULT_CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS,
        reconcileIntervalMs: DEFAULT_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
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
        BRIDGE_CALLBACK_BASE_URL: "http://api.internal.test:4100/",
        BRIDGE_SESSION_TOKEN_HEADER: "X-Agent-Pool-Bridge-Session",
        RABBITMQ_URL: "amqp://rabbitmq.local.test:5672",
        RABBITMQ_MANAGEMENT_URL: "http://rabbitmq.local.test:15672/",
        RABBITMQ_PROJECT_TASK_QUEUE_PREFIX: "tasks",
        RABBITMQ_PROJECT_CONTROL_QUEUE_PREFIX: "control",
        STORAGE_ADAPTER: "blob",
        STORAGE_LOCAL_ROOT: "/tmp/agent-pool-storage",
        STORAGE_BUCKET: "agent-pool-test-bucket",
        RUNTIME_PROVIDER: "docker",
        COMPOSE_SMOKE_ENABLED: "true",
        COMPOSE_SMOKE_PROJECT_ID: "project-compose",
        CONTROL_PLANE_WORKER_POLL_INTERVAL_MS: "250",
        CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS: "500",
        CONTROL_PLANE_RECONCILE_INTERVAL_MS: "1500",
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
      bridge: {
        callbackBaseUrl: "http://api.internal.test:4100",
        sessionTokenHeaderName: "x-agent-pool-bridge-session",
      },
      orchestrator: {
        port: 4101,
        publicUrl: "http://orchestrator.local.test:4101",
        backendInternalUrl: "http://api.internal.test:4100",
      },
      rabbitmq: {
        url: "amqp://rabbitmq.local.test:5672",
        managementUrl: "http://rabbitmq.local.test:15672",
        projectTaskQueuePrefix: "tasks",
        projectControlQueuePrefix: "control",
      },
      storage: {
        adapter: "blob",
        localRoot: "/tmp/agent-pool-storage",
        bucket: "agent-pool-test-bucket",
      },
      controlPlane: {
        runtimeProvider: "docker",
        smokeEnabled: true,
        smokeProjectId: "project-compose",
        workerPollIntervalMs: 250,
        outboxPublishIntervalMs: 500,
        reconcileIntervalMs: 1500,
      },
    });
  });

  test("rejects invalid ports, URLs, runtime config, and storage adapters", () => {
    expect(() => loadConfig({ AUTH_MODE: "test", API_PORT: "70000" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", BRIDGE_CALLBACK_BASE_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() =>
      loadConfig({
        AUTH_MODE: "test",
        INTERNAL_SERVICE_TOKEN_HEADER: "x-shared-token",
        BRIDGE_SESSION_TOKEN_HEADER: "x-shared-token",
      }),
    ).toThrow("BRIDGE_SESSION_TOKEN_HEADER must be distinct");
    expect(() => loadConfig({ AUTH_MODE: "test", RABBITMQ_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", RABBITMQ_MANAGEMENT_URL: "not-a-url" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", STORAGE_ADAPTER: "s3" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", RUNTIME_PROVIDER: "stub" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", COMPOSE_SMOKE_ENABLED: "sometimes" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", COMPOSE_SMOKE_PROJECT_ID: "../bad" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", CONTROL_PLANE_WORKER_POLL_INTERVAL_MS: "0" })).toThrow(ConfigError);
  });
});
