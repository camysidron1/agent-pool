import { describe, expect, test } from "bun:test";

import {
  ConfigError,
  DEFAULT_BACKEND_INTERNAL_URL,
  DEFAULT_BRIDGE_SESSION_TOKEN_HEADER,
  DEFAULT_CONTROL_PLANE_OUTBOX_PUBLISH_INTERVAL_MS,
  DEFAULT_CONTROL_PLANE_RECONCILE_INTERVAL_MS,
  DEFAULT_CONTROL_PLANE_SMOKE_PROJECT_ID,
  DEFAULT_CONTROL_PLANE_WORKER_POLL_INTERVAL_MS,
  DEFAULT_E2B_API_KEY_ENV_NAME,
  DEFAULT_E2B_CLEANUP_TIMEOUT_MS,
  DEFAULT_E2B_GITHUB_TOKEN_ENV_NAME,
  DEFAULT_E2B_STARTUP_TIMEOUT_MS,
  DEFAULT_E2B_WORKING_DIRECTORY,
  DEFAULT_ORCHESTRATOR_URL,
  DEFAULT_PUBLIC_AUTH_COOKIE_NAME,
  DEFAULT_PUBLIC_AUTH_PASSWORD,
  DEFAULT_PUBLIC_AUTH_SESSION_SECRET,
  DEFAULT_PUBLIC_AUTH_SESSION_TTL_SECONDS,
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
      publicAuth: {
        operatorPassword: DEFAULT_PUBLIC_AUTH_PASSWORD,
        sessionSecret: DEFAULT_PUBLIC_AUTH_SESSION_SECRET,
        cookieName: DEFAULT_PUBLIC_AUTH_COOKIE_NAME,
        cookieSecure: false,
        sessionTtlSeconds: DEFAULT_PUBLIC_AUTH_SESSION_TTL_SECONDS,
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
        e2b: {
          apiKeyEnvName: DEFAULT_E2B_API_KEY_ENV_NAME,
          apiKeyConfigured: false,
          templateId: null,
          sandboxImageId: null,
          workingDirectory: DEFAULT_E2B_WORKING_DIRECTORY,
          startupTimeoutMs: DEFAULT_E2B_STARTUP_TIMEOUT_MS,
          cleanupTimeoutMs: DEFAULT_E2B_CLEANUP_TIMEOUT_MS,
          githubTokenEnvName: DEFAULT_E2B_GITHUB_TOKEN_ENV_NAME,
          githubTokenConfigured: false,
          allowedSecretEnvNames: [],
        },
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
        OPERATOR_PASSWORD: "operator-password",
        PUBLIC_AUTH_SESSION_SECRET: "public-auth-session-secret-123456",
        PUBLIC_AUTH_COOKIE_NAME: "agent_pool_local_session",
        PUBLIC_AUTH_COOKIE_SECURE: "true",
        PUBLIC_AUTH_SESSION_TTL_SECONDS: "3600",
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
        E2B_API_KEY_ENV_NAME: "CUSTOM_E2B_KEY",
        CUSTOM_E2B_KEY: "not-returned",
        E2B_TEMPLATE_ID: "template-1",
        E2B_SANDBOX_IMAGE_ID: "image:1",
        E2B_WORKING_DIRECTORY: "/workspace/custom/",
        E2B_STARTUP_TIMEOUT_MS: "90000",
        E2B_CLEANUP_TIMEOUT_MS: "45000",
        E2B_GITHUB_TOKEN_ENV_NAME: "CUSTOM_GITHUB_TOKEN",
        CUSTOM_GITHUB_TOKEN: "also-not-returned",
        E2B_ALLOWED_SECRET_ENV_NAMES: "CUSTOM_E2B_KEY,CUSTOM_GITHUB_TOKEN,CUSTOM_E2B_KEY",
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
      publicAuth: {
        operatorPassword: "operator-password",
        sessionSecret: "public-auth-session-secret-123456",
        cookieName: "agent_pool_local_session",
        cookieSecure: true,
        sessionTtlSeconds: 3600,
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
        e2b: {
          apiKeyEnvName: "CUSTOM_E2B_KEY",
          apiKeyConfigured: true,
          templateId: "template-1",
          sandboxImageId: "image:1",
          workingDirectory: "/workspace/custom",
          startupTimeoutMs: 90000,
          cleanupTimeoutMs: 45000,
          githubTokenEnvName: "CUSTOM_GITHUB_TOKEN",
          githubTokenConfigured: true,
          allowedSecretEnvNames: ["CUSTOM_E2B_KEY", "CUSTOM_GITHUB_TOKEN"],
        },
      },
    });
  });

  test("validates required E2B settings only when E2B provider is selected", () => {
    expect(loadConfig({ AUTH_MODE: "test", RUNTIME_PROVIDER: "fake", E2B_TEMPLATE_ID: "template-1" }).controlPlane.e2b).toMatchObject({
      apiKeyEnvName: DEFAULT_E2B_API_KEY_ENV_NAME,
      apiKeyConfigured: false,
      templateId: "template-1",
    });

    expect(() => loadConfig({ AUTH_MODE: "test", RUNTIME_PROVIDER: "e2b", E2B_TEMPLATE_ID: "template-1" })).toThrow(
      "E2B_API_KEY is required when RUNTIME_PROVIDER=e2b",
    );
    expect(() =>
      loadConfig({
        AUTH_MODE: "test",
        RUNTIME_PROVIDER: "e2b",
        E2B_API_KEY: "secret",
      }),
    ).toThrow("E2B_TEMPLATE_ID or E2B_SANDBOX_IMAGE_ID is required when RUNTIME_PROVIDER=e2b");

    expect(
      loadConfig({
        AUTH_MODE: "test",
        RUNTIME_PROVIDER: "e2b",
        E2B_API_KEY: "secret",
        E2B_TEMPLATE_ID: "template-1",
      }).controlPlane.e2b,
    ).toMatchObject({
      apiKeyConfigured: true,
      templateId: "template-1",
      sandboxImageId: null,
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
    expect(() => loadConfig({ AUTH_MODE: "test", E2B_API_KEY_ENV_NAME: "E2B-Key" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", E2B_TEMPLATE_ID: "../template" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", E2B_WORKING_DIRECTORY: "relative/path" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", E2B_STARTUP_TIMEOUT_MS: "0" })).toThrow(ConfigError);
    expect(() => loadConfig({ AUTH_MODE: "test", E2B_ALLOWED_SECRET_ENV_NAMES: "GOOD,bad" })).toThrow(ConfigError);
  });
});
