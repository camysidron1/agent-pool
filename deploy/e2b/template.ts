import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Template } from "e2b";
import { AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST } from "@agent-pool/runtime";

export const AGENT_POOL_E2B_TEMPLATE_NAME = "agent-pool-bun-git";
export const AGENT_POOL_E2B_BUN_VERSION = AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST.bunVersion;
export const AGENT_POOL_E2B_CODEX_PACKAGE = AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST.codexPackage;

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templateManifestJson = `${JSON.stringify(AGENT_POOL_E2B_TEMPLATE_COMPATIBILITY_MANIFEST, null, 2)}\n`;

export const agentPoolE2BTemplate = Template({
  fileContextPath: repoRoot,
  fileIgnorePatterns: [
    ".git",
    "node_modules",
    "apps/*/node_modules",
    "packages/*/node_modules",
    "apps/web/dist",
    "v2/node_modules",
    "v2/dist",
    "agent-docs",
    "shared-docs",
    "data",
    "docs",
    "approvals",
    ".agent-pool",
    ".claude",
    "*.tfstate",
    "*.tfstate.*",
    "*.tfplan",
  ],
})
  .fromBunImage(AGENT_POOL_E2B_BUN_VERSION)
  .runCmd(
    [
      "apt-get update",
      "apt-get install -y --no-install-recommends git ca-certificates gh jq ripgrep bubblewrap npm",
      `npm install -g ${AGENT_POOL_E2B_CODEX_PACKAGE}`,
      "rm -rf /var/lib/apt/lists/* /root/.npm",
    ].join(" && "),
    { user: "root" },
  )
  .makeDir("/agent-pool/bin", { user: "root", mode: 0o755 })
  .runCmd(`printf %s ${quoteShellArg(templateManifestJson)} > /agent-pool/e2b-template-manifest.json`, { user: "root" })
  .copy("deploy/e2b/github-token-askpass", "/agent-pool/bin/github-token-askpass", { mode: 0o755 })
  .copy("packages/session-bridge/src", "/agent-pool/session-bridge/src")
  .copy("packages/session-bridge/package.json", "/agent-pool/session-bridge/package.json")
  .setWorkdir("/workspace");

function quoteShellArg(value: string): string {
  if (value.length > 0 && /^[A-Za-z0-9_@%+=:,./-]+$/.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", "'\\''")}'`;
}
