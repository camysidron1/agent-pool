import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { createE2BTemplateBuildPlan } from "../../../deploy/e2b/build-template";

describe("E2B template assets", () => {
  test("keeps E2B template build opt-in and out of the default test script", async () => {
    const packageJson = JSON.parse(await readFile(join(process.cwd(), "package.json"), "utf8")) as {
      readonly scripts: Record<string, string>;
    };

    expect(packageJson.scripts.test).toBe("bun test apps packages");
    expect(packageJson.scripts["e2b:template:build"]).toBe("bun run deploy/e2b/build-template.ts");
  });

  test("defines a Bun and Git sandbox template with scoped GitHub askpass", async () => {
    const templateSource = await readFile(join(process.cwd(), "deploy", "e2b", "template.ts"), "utf8");
    const askpassSource = await readFile(join(process.cwd(), "deploy", "e2b", "github-token-askpass"), "utf8");

    expect(templateSource).toContain('.fromBunImage(AGENT_POOL_E2B_BUN_VERSION)');
    expect(templateSource).toContain("apt-get install -y --no-install-recommends git ca-certificates");
    expect(templateSource).toContain('copy("deploy/e2b/github-token-askpass", "/agent-pool/bin/github-token-askpass"');
    expect(askpassSource).toContain('AGENT_POOL_GITHUB_TOKEN_ENV:-GITHUB_TOKEN');
    expect(askpassSource).toContain("x-access-token");
    expect(`${templateSource}\n${askpassSource}`).not.toMatch(/ghp_|github_pat_|e2b_[A-Za-z0-9_-]{20,}|BEGIN (RSA|OPENSSH) PRIVATE KEY/);
  });

  test("build plan validates inputs without requiring an E2B API key or provider call", () => {
    expect(createE2BTemplateBuildPlan(["--dry-run"], {})).toEqual({
      name: "agent-pool-bun-git",
      cpuCount: 1,
      memoryMB: 1024,
      apiKeyConfigured: false,
      dryRun: true,
    });
    expect(
      createE2BTemplateBuildPlan(["--name", "agent-pool-bun-git-dev", "--cpu-count", "2", "--memory-mb", "2048"], {
        E2B_API_KEY: "configured",
      }),
    ).toEqual({
      name: "agent-pool-bun-git-dev",
      cpuCount: 2,
      memoryMB: 2048,
      apiKeyConfigured: true,
      dryRun: false,
    });
    expect(() => createE2BTemplateBuildPlan(["--cpu-count", "0"], {})).toThrow("--cpu-count must be a positive integer");
  });
});
