export const AGENT_POOL_CODEX_COMMAND_PROFILE = "agent-pool-bun-pr" as const;

export type CodexCommandPolicyCheck =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

export type CodexCommandPolicyOptions = {
  readonly expectedBranchName?: string | null;
};

export type CodexPromptInput = {
  readonly taskTitle: string;
  readonly taskDescription?: string;
  readonly workspaceRoot: string;
  readonly repositoryUrl?: string;
  readonly baseRef?: string;
  readonly branchName?: string;
  readonly commandProfile: string;
  readonly allowedEgressDomains?: readonly string[];
};

const INSPECTION_COMMANDS = new Set([
  "pwd",
  "ls",
  "find",
  "rg",
  "cat",
  "sed",
  "awk",
  "head",
  "tail",
  "wc",
  "sort",
  "uniq",
]);

const FORBIDDEN_COMMANDS = new Set([
  "curl",
  "wget",
  "ssh",
  "scp",
  "docker",
  "kubectl",
  "terraform",
  "aws",
  "bash",
  "sh",
  "zsh",
  "npm",
  "npx",
  "pnpm",
  "yarn",
]);

const SENSITIVE_ARG_PATTERN =
  /(^|[\/\s'"=:])(\.env(\.|$|[\/\s'"=:])|\.codex($|[\/\s'"=:])|\.config\/gh($|[\/\s'"=:])|hosts\.yml|auth\.json|credential(s)?|github_token|codex_api_key|api[_-]?key|access[_-]?token|secret|password|token($|[\/\s'"=:]))/i;

export function checkCodexCommandPolicy(
  command: readonly string[],
  options: CodexCommandPolicyOptions = {},
): CodexCommandPolicyCheck {
  const executable = command[0]?.trim();
  if (!executable) return { allowed: false, reason: "empty_command" };
  const joined = command.join(" ");

  if (/\brm\s+-[^\s]*r[^\s]*f|\brm\s+-[^\s]*f[^\s]*r/.test(joined)) return { allowed: false, reason: "destructive_rm_forbidden" };
  if (executable === "gh" && command[1] === "api") return { allowed: false, reason: "gh_api_forbidden" };
  if (executable === "gh" && command[1] === "secret") return { allowed: false, reason: "gh_secret_forbidden" };
  if (executable === "gh" && command[1] === "auth" && command[2] === "token") {
    return { allowed: false, reason: "gh_auth_token_forbidden" };
  }
  if (SENSITIVE_ARG_PATTERN.test(joined)) return { allowed: false, reason: "credential_access_forbidden" };
  if (FORBIDDEN_COMMANDS.has(executable)) return { allowed: false, reason: `${executable}_forbidden` };
  if (INSPECTION_COMMANDS.has(executable)) return { allowed: true };
  if (executable === "git") return checkGitCommand(command, options);
  if (executable === "bun") return checkBunCommand(command);
  if (executable === "gh") return checkGhCommand(command);

  return { allowed: false, reason: "command_not_in_profile" };
}

export function createCodexPrompt(input: CodexPromptInput): string {
  if (input.commandProfile !== AGENT_POOL_CODEX_COMMAND_PROFILE) {
    throw new Error(`unsupported codex command profile: ${input.commandProfile}`);
  }

  return [
    `You are running inside an Agent Pool E2B Firecracker sandbox at ${input.workspaceRoot}.`,
    "Complete the assigned task by making a focused repository change, committing it, pushing a task branch, and opening a GitHub pull request.",
    "A pull request URL is required for success. Put the PR URL in your final response.",
    "",
    `Task: ${input.taskTitle}`,
    input.taskDescription?.trim() ? `Details: ${input.taskDescription.trim()}` : "",
    input.repositoryUrl ? `Repository: ${input.repositoryUrl}` : "",
    input.baseRef ? `Base ref: ${input.baseRef}` : "",
    input.branchName ? `Task branch: ${input.branchName}` : "",
    `Command profile: ${input.commandProfile}`,
    input.allowedEgressDomains?.length ? `Allowed egress domains: ${input.allowedEgressDomains.join(", ")}` : "",
    "",
    "Rules:",
    "- Work only inside the checked-out repository and the agent-docs/shared-docs paths when notes are needed.",
    "- Do not persist Codex, GitHub, proxy, or API credentials to disk.",
    "- Do not use curl, wget, ssh, scp, docker, kubectl, terraform, aws, gh api, gh secret, or gh auth token.",
    "- Use bun install --frozen-lockfile, bun run typecheck, and bun run test for this repository unless the task clearly requires narrower declared checks first.",
    "- Do not touch the legacy v2/TUI database path or ~/.agent-pool/data/agent-pool.db.",
    "- Preserve the backend DB ownership boundary: only apps/api may construct or open the backend DB.",
  ]
    .filter(Boolean)
    .join("\n");
}

export function extractPullRequestUrl(text: string): string | null {
  return text.match(/https:\/\/github\.com\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[0-9]+/i)?.[0] ?? null;
}

function checkGitCommand(command: readonly string[], options: CodexCommandPolicyOptions): CodexCommandPolicyCheck {
  const subcommandIndex = command[1] === "-C" ? 3 : 1;
  const subcommand = command[subcommandIndex];
  if (!subcommand) return { allowed: false, reason: "git_subcommand_missing" };
  if (["status", "diff", "log", "show", "branch", "add", "commit"].includes(subcommand)) return { allowed: true };
  if (subcommand === "checkout") return command.includes("--") ? { allowed: false, reason: "unsafe_checkout_form" } : { allowed: true };
  if (subcommand === "push") {
    const remote = command[subcommandIndex + 1];
    const branch = command[subcommandIndex + 2];
    if (remote !== "origin") return { allowed: false, reason: "git_push_origin_required" };
    if (command.some((part) => part === "--force" || part === "-f" || part.startsWith("--force"))) {
      return { allowed: false, reason: "git_push_force_forbidden" };
    }
    if (branch && ["main", "master", "stg", "stage", "prod", "production"].includes(branch)) {
      return { allowed: false, reason: "git_push_protected_branch_forbidden" };
    }
    if (options.expectedBranchName && branch && branch !== options.expectedBranchName) {
      return { allowed: false, reason: "git_push_task_branch_required" };
    }
    return { allowed: true };
  }
  return { allowed: false, reason: `git_${subcommand}_not_in_profile` };
}

function checkBunCommand(command: readonly string[]): CodexCommandPolicyCheck {
  if (command[1] === "install") {
    return command.length === 3 && command[2] === "--frozen-lockfile"
      ? { allowed: true }
      : { allowed: false, reason: "bun_install_frozen_lockfile_required" };
  }
  if (command[1] === "run" && ["typecheck", "test"].includes(command[2] ?? "")) return { allowed: true };
  return { allowed: false, reason: "bun_command_not_in_profile" };
}

function checkGhCommand(command: readonly string[]): CodexCommandPolicyCheck {
  if (command[1] === "repo" && command[2] === "view") return { allowed: true };
  if (command[1] === "pr" && ["create", "view", "status"].includes(command[2] ?? "")) return { allowed: true };
  return { allowed: false, reason: "gh_command_not_in_profile" };
}
