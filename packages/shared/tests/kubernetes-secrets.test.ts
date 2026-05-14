import { describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";

import {
  buildAgentPoolSecrets,
  parseEnvFile,
  parseKubernetesSecretsArgs,
  runKubernetesSecretsCli,
} from "../../../deploy/kubernetes/apply-secrets";

describe("Kubernetes secret apply helper", () => {
  test("plans secrets without exposing secret values", async () => {
    const writes: string[] = [];
    const code = await runKubernetesSecretsCli(["--dry-run", "--require-e2b", "--no-env-file"], {
      env: {
        OPERATOR_PASSWORD: "operator-password-123",
        E2B_API_KEY: "e2b-secret-value",
        GITHUB_TOKEN: "github-secret-value",
      },
      write: (text) => writes.push(text),
      randomSecret: (bytes) => `generated-${bytes}-${"x".repeat(bytes)}`,
      kubectl: async () => {
        throw new Error("kubectl should not run during dry-run");
      },
    });

    expect(code).toBe(0);
    const output = writes.join("");
    expect(output).toContain('"ok": true');
    expect(output).toContain('"E2B_API_KEY"');
    expect(output).toContain('"GITHUB_TOKEN"');
    expect(output).toContain('"source": "env"');
    expect(output).not.toContain("e2b-secret-value");
    expect(output).not.toContain("github-secret-value");
    expect(output).not.toContain("operator-password-123");
    expect(output).not.toContain("generated-48");
  });

  test("reuses existing cluster secrets and only applies redacted output", async () => {
    const writes: string[] = [];
    const appliedManifests: string[] = [];
    const existingSecret = {
      data: {
        INTERNAL_SERVICE_TOKEN: b64("existing-service-token"),
        OPERATOR_PASSWORD: b64("existing-operator-password"),
        PUBLIC_AUTH_SESSION_SECRET: b64("existing-session-secret-1234567890"),
        RABBITMQ_DEFAULT_PASS: b64("existing-rabbitmq-password"),
        MINIO_ROOT_PASSWORD: b64("existing-minio-password"),
        E2B_API_KEY: b64("existing-e2b-key"),
      },
    };

    const code = await runKubernetesSecretsCli(["--require-e2b", "--no-env-file"], {
      env: { GITHUB_TOKEN: "new-github-token" },
      write: (text) => writes.push(text),
      randomSecret: (bytes) => `generated-${bytes}`,
      kubectl: async (args, options = {}) => {
        if (args.join(" ") === "-n agent-pool get secret agent-pool-secrets -o json") {
          return { exitCode: 0, stdout: JSON.stringify(existingSecret), stderr: "" };
        }
        if (args.join(" ") === "apply -f -") {
          appliedManifests.push(options.stdin ?? "");
          return { exitCode: 0, stdout: "secret/agent-pool-secrets configured\n", stderr: "" };
        }
        return { exitCode: 1, stdout: "", stderr: `unexpected kubectl call: ${args.join(" ")}` };
      },
    });

    expect(code).toBe(0);
    expect(appliedManifests).toHaveLength(1);

    const manifest = JSON.parse(appliedManifests[0]) as { readonly stringData: Record<string, string> };
    expect(manifest.stringData.INTERNAL_SERVICE_TOKEN).toBe("existing-service-token");
    expect(manifest.stringData.E2B_API_KEY).toBe("existing-e2b-key");
    expect(manifest.stringData.GITHUB_TOKEN).toBe("new-github-token");
    expect(manifest.stringData.RABBITMQ_URL).toContain("existing-rabbitmq-password");

    const output = writes.join("");
    expect(output).toContain('"existingSecretFound": true');
    expect(output).toContain('"source": "cluster"');
    expect(output).toContain('"source": "env"');
    expect(output).not.toContain("existing-service-token");
    expect(output).not.toContain("existing-e2b-key");
    expect(output).not.toContain("new-github-token");
  });

  test("requires explicit operator password and optional real E2B credentials", () => {
    expect(() =>
      buildAgentPoolSecrets({
        overrides: { values: {}, sources: {} },
        randomSecret: (bytes) => `generated-${bytes}`,
      }),
    ).toThrow("missing required secret values: OPERATOR_PASSWORD");

    expect(() =>
      buildAgentPoolSecrets({
        overrides: {
          values: { OPERATOR_PASSWORD: "operator-password-123" },
          sources: { OPERATOR_PASSWORD: "env" },
        },
        requireE2B: true,
        randomSecret: (bytes) => `generated-${bytes}`,
      }),
    ).toThrow("missing required secret values: E2B_API_KEY, GITHUB_TOKEN");
  });

  test("parses env files and keeps command defaults injectable", () => {
    expect(
      parseEnvFile(`
        # local only
        OPERATOR_PASSWORD="operator-password-123"
        E2B_API_KEY='e2b-secret'
        GITHUB_TOKEN=github-token
      `),
    ).toEqual({
      OPERATOR_PASSWORD: "operator-password-123",
      E2B_API_KEY: "e2b-secret",
      GITHUB_TOKEN: "github-token",
    });

    expect(
      parseKubernetesSecretsArgs(["--namespace", "agent-pool-dev", "--name", "agent-pool-secrets-dev"], {
        AGENT_POOL_SECRETS_FILE: "deploy/kubernetes/local.secrets.env",
      }),
    ).toMatchObject({
      namespace: "agent-pool-dev",
      name: "agent-pool-secrets-dev",
      envFile: "deploy/kubernetes/local.secrets.env",
    });
  });
});

function b64(value: string): string {
  return Buffer.from(value, "utf8").toString("base64");
}
