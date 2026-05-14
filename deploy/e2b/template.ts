import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Template } from "e2b";

export const AGENT_POOL_E2B_TEMPLATE_NAME = "agent-pool-bun-git";
export const AGENT_POOL_E2B_BUN_VERSION = "1.2.23";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

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
    "apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*",
    { user: "root" },
  )
  .makeDir("/agent-pool/bin", { user: "root", mode: 0o755 })
  .copy("deploy/e2b/github-token-askpass", "/agent-pool/bin/github-token-askpass", { mode: 0o755 })
  .setWorkdir("/workspace");
