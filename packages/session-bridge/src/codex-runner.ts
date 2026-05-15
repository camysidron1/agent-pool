import { spawn } from "node:child_process";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { createBridgeRunner, type BridgeRunnerRunOnceResult } from "./runner";
import type { BridgeRunnerOutputInput } from "./runner";
import type { BridgeSessionOptions } from "./index";
import {
  AGENT_POOL_CODEX_COMMAND_PROFILE,
  createCodexPrompt,
  extractPullRequestUrl,
} from "./codex-policy";
import {
  CodexCommandPolicyViolationError,
  createCodexCommandSupervisor,
  type CodexCommandSupervisorDecision,
} from "./command-supervisor";
import { inspectUntrustedRepositoryContext, type UntrustedContextFinding } from "./untrusted-context";

export type CodexRunnerEnvironment = Readonly<Record<string, string | undefined>>;

export type CodexProcessExecutionInput = {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly onStdout?: (chunk: string) => void | Promise<void>;
  readonly onStderr?: (chunk: string) => void | Promise<void>;
};

export type CodexProcessExecutionResult = {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
};

export type CodexProcessExecutor = (input: CodexProcessExecutionInput) => Promise<CodexProcessExecutionResult>;

export type CodexBridgeSessionOptions = {
  readonly session: BridgeSessionOptions;
  readonly workspaceRoot: string;
  readonly env?: CodexRunnerEnvironment;
  readonly fetch?: typeof fetch;
  readonly executeProcess?: CodexProcessExecutor;
  readonly credentialScrubVerificationPaths?: readonly string[];
};

export type CodexBridgeSessionResult = {
  readonly ok: boolean;
  readonly pullRequestUrl: string | null;
  readonly exitCode: number | null;
  readonly firstPass: BridgeRunnerRunOnceResult;
  readonly terminalPass: BridgeRunnerRunOnceResult;
};

type CodexRunnerConfig = {
  readonly command: string;
  readonly commandProfile: string;
  readonly model: string | null;
  readonly codexHome: string;
  readonly finalResponsePath: string;
  readonly eventsPath: string;
  readonly allowedEgressDomains: readonly string[];
  readonly taskTitle: string;
  readonly taskDescription: string | null;
  readonly repositoryUrl: string | null;
  readonly baseRef: string | null;
  readonly branchName: string | null;
};

export type CodexCredentialScrubResult = {
  readonly ok: boolean;
  readonly removedPaths: readonly string[];
  readonly verifiedAbsentPaths: readonly string[];
  readonly remainingPaths: readonly string[];
  readonly errorMessage?: string;
};

type DependencyInstallPhaseResult = {
  readonly ok: boolean;
  readonly command: readonly string[];
  readonly exitCode: number;
  readonly lockfileChanged: boolean;
  readonly changedFiles: readonly string[];
};

const DEPENDENCY_INSTALL_COMMAND = ["bun", "install", "--frozen-lockfile"] as const;

export async function runCodexBridgeSession(options: CodexBridgeSessionOptions): Promise<CodexBridgeSessionResult> {
  const env = options.env ?? readProcessEnv();
  const config = readCodexRunnerConfig(env, options.session, options.workspaceRoot);
  const executeProcess = options.executeProcess ?? executeNodeProcess;
  const bridge = createBridgeRunner({
    session: options.session,
    workspaceRoot: options.workspaceRoot,
    fetch: options.fetch,
  });
  await mkdir(dirname(config.finalResponsePath), { recursive: true });
  await mkdir(config.codexHome, { recursive: true });

  const untrustedContext = await inspectUntrustedRepositoryContext({
    workspaceRoot: options.workspaceRoot,
    commandProfile: config.commandProfile,
    allowedEgressDomains: config.allowedEgressDomains,
  });
  const prompt = createCodexPrompt({
    taskTitle: config.taskTitle,
    taskDescription: config.taskDescription ?? undefined,
    workspaceRoot: options.workspaceRoot,
    repositoryUrl: config.repositoryUrl ?? undefined,
    baseRef: config.baseRef ?? undefined,
    branchName: config.branchName ?? undefined,
    commandProfile: config.commandProfile,
    allowedEgressDomains: config.allowedEgressDomains,
    untrustedContextSummaries: untrustedContext.promptSummaries,
  });
  await writeCodexPolicyFiles(config);
  const commandSupervisor = createCodexCommandSupervisor({
    commandProfile: config.commandProfile,
    expectedBranchName: config.branchName,
  });

  const firstPass = await bridge.runOnce({
    output: [
      {
        stream: "system",
        text: `codex runner starting with command profile ${config.commandProfile}`,
      },
      securityOutput("codex-started", { allowed: true, policy: config.commandProfile }),
      ...untrustedContext.findings.map((finding) => securityOutput("untrusted-context", untrustedContextMetadata(finding, config))),
    ],
  });

  let stdout = "";
  let stderr = "";
  let exitCode: number | null = null;
  let pullRequestUrl: string | null = null;
  let terminalPass: BridgeRunnerRunOnceResult;
  let installPhase: DependencyInstallPhaseResult | null = null;

  try {
    installPhase = await runDependencyInstallPhase({
      executeProcess,
      env,
      config,
      workspaceRoot: options.workspaceRoot,
      bridge,
    });
    if (!installPhase.ok) {
      const scrubResult = await scrubAndReport({
        bridge,
        env,
        config,
        verifyPaths: options.credentialScrubVerificationPaths,
      });
      terminalPass = await bridge.runOnce({
        failure: {
          errorMessage: "dependency install phase failed before codex execution",
          metadata: { runner: "codex", commandProfile: config.commandProfile, installPhase },
        },
        cleanup: cleanupMetadata("dependency install failed", config, { exitCode, pullRequestUrl, installPhase }, scrubResult),
      });
      return { ok: false, pullRequestUrl, exitCode, firstPass, terminalPass };
    }

    const result = await executeProcess({
      command: config.command,
      args: buildCodexArgs(config, options.workspaceRoot, prompt),
      cwd: options.workspaceRoot,
      env: buildCodexEnvironment(env, config),
      onStdout: async (chunk) => {
        stdout += chunk;
        pullRequestUrl ??= extractPullRequestUrl(chunk);
        await enforceCommandSupervisorDecisions({
          decisions: commandSupervisor.inspectChunk(chunk),
          bridge,
          env,
        });
        if (isPackageInstallOutput(chunk)) {
          await bridge.runOnce({ output: [securityOutput("package-install", { allowed: true, policy: config.commandProfile })] });
        }
        await bridge.runOnce({ output: [{ stream: "stdout", text: chunk }] });
      },
      onStderr: async (chunk) => {
        stderr += chunk;
        pullRequestUrl ??= extractPullRequestUrl(chunk);
        await enforceCommandSupervisorDecisions({
          decisions: commandSupervisor.inspectChunk(chunk),
          bridge,
          env,
        });
        await bridge.runOnce({ output: [{ stream: "stderr", text: chunk }] });
      },
    });

    exitCode = result.exitCode;
    await enforceCommandSupervisorDecisions({
      decisions: commandSupervisor.flush(),
      bridge,
      env,
    });
    stdout = mergeProcessText(stdout, result.stdout);
    stderr = mergeProcessText(stderr, result.stderr);
    const finalText = await readFinalResponse(config.finalResponsePath, stdout, stderr);
    pullRequestUrl ??= extractPullRequestUrl(finalText) ?? extractPullRequestUrl(stdout) ?? extractPullRequestUrl(stderr);
    pullRequestUrl ??= await readPullRequestUrlFromGh({ executeProcess, env, config, workspaceRoot: options.workspaceRoot });
    const postflight = await runCodexPostflight({ executeProcess, env, config, workspaceRoot: options.workspaceRoot, pullRequestUrl });
    await bridge.runOnce({ output: [securityOutput("postflight", { ...postflight, installPhase })] });
    const scrubResult = await scrubAndReport({
      bridge,
      env,
      config,
      verifyPaths: options.credentialScrubVerificationPaths,
    });

    if (exitCode !== 0) {
      terminalPass = await bridge.runOnce({
        failure: {
          errorMessage: `codex exec exited ${exitCode}`,
          metadata: { runner: "codex", commandProfile: config.commandProfile, stderr: truncate(stderr), installPhase },
        },
        cleanup: cleanupMetadata("codex failed", config, { exitCode, pullRequestUrl, postflight }, scrubResult),
      });
      return { ok: false, pullRequestUrl, exitCode, firstPass, terminalPass };
    }

    if (!pullRequestUrl) {
      terminalPass = await bridge.runOnce({
        failure: {
          errorMessage: "codex runner completed without a pull request URL",
          metadata: { runner: "codex", commandProfile: config.commandProfile, postflight, installPhase },
        },
        cleanup: cleanupMetadata("codex missing pull request", config, { exitCode, pullRequestUrl, postflight }, scrubResult),
      });
      return { ok: false, pullRequestUrl, exitCode, firstPass, terminalPass };
    }

    terminalPass = await bridge.runOnce({
      finalResponseText: finalText,
      finalResponseMetadata: { runner: "codex", commandProfile: config.commandProfile, pullRequestUrl, postflight, installPhase },
      completion: { metadata: { runner: "codex", commandProfile: config.commandProfile, pullRequestUrl, postflight, installPhase } },
      cleanup: cleanupMetadata("codex completed", config, { exitCode, pullRequestUrl, postflight }, scrubResult),
    });
    return { ok: true, pullRequestUrl, exitCode, firstPass, terminalPass };
  } catch (error) {
    const scrubResult = await scrubAndReport({
      bridge,
      env,
      config,
      verifyPaths: options.credentialScrubVerificationPaths,
    });
    terminalPass = await bridge.runOnce({
      failure: {
        errorMessage: `codex runner failed: ${redactKnownSecrets(errorMessage(error), env)}`,
        metadata: { runner: "codex", commandProfile: config.commandProfile, installPhase },
      },
      cleanup: cleanupMetadata("codex runner failed", config, { exitCode, pullRequestUrl }, scrubResult),
    });
    return { ok: false, pullRequestUrl, exitCode, firstPass, terminalPass };
  }
}

async function runDependencyInstallPhase(input: {
  readonly executeProcess: CodexProcessExecutor;
  readonly env: CodexRunnerEnvironment;
  readonly config: CodexRunnerConfig;
  readonly workspaceRoot: string;
  readonly bridge: Pick<ReturnType<typeof createBridgeRunner>, "runOnce">;
}): Promise<DependencyInstallPhaseResult> {
  await input.bridge.runOnce({
    output: [
      securityOutput("dependency-install-started", {
        phase: "install",
        command: DEPENDENCY_INSTALL_COMMAND.join(" "),
        policy: input.config.commandProfile,
        allowed: true,
      }),
    ],
  });

  const result = await input
    .executeProcess({
      command: DEPENDENCY_INSTALL_COMMAND[0],
      args: DEPENDENCY_INSTALL_COMMAND.slice(1),
      cwd: input.workspaceRoot,
      env: buildDependencyInstallEnvironment(input.env),
      onStdout: async (chunk) => {
        const text = redactKnownSecrets(chunk, input.env);
        if (isPackageInstallOutput(text)) {
          await input.bridge.runOnce({
            output: [
              securityOutput("package-install", {
                phase: "install",
                command: DEPENDENCY_INSTALL_COMMAND.join(" "),
                allowed: true,
                policy: input.config.commandProfile,
              }),
            ],
          });
        }
        await input.bridge.runOnce({ output: [{ stream: "stdout", text }] });
      },
      onStderr: async (chunk) => {
        await input.bridge.runOnce({ output: [{ stream: "stderr", text: redactKnownSecrets(chunk, input.env) }] });
      },
    })
    .catch((error) => ({ exitCode: 1, stdout: "", stderr: errorMessage(error) }));
  const changedFiles = await readTrackedDependencyFiles(input);
  const lockfileChanged = changedFiles.some(isLockfilePath);
  const phaseResult: DependencyInstallPhaseResult = {
    ok: result.exitCode === 0,
    command: DEPENDENCY_INSTALL_COMMAND,
    exitCode: result.exitCode,
    lockfileChanged,
    changedFiles,
  };

  await input.bridge.runOnce({
    output: [
      securityOutput(result.exitCode === 0 ? "dependency-install-finished" : "dependency-install-failed", {
        phase: "install",
        command: DEPENDENCY_INSTALL_COMMAND.join(" "),
        allowed: result.exitCode === 0,
        policy: input.config.commandProfile,
        exitCode: result.exitCode,
        lockfileChanged,
        changedFiles,
      }),
    ],
  });
  return phaseResult;
}

export async function scrubCodexSandboxSecrets(input: {
  readonly env: CodexRunnerEnvironment;
  readonly config: Pick<CodexRunnerConfig, "codexHome"> & Partial<Pick<CodexRunnerConfig, "eventsPath" | "finalResponsePath">>;
  readonly verifyPaths?: readonly string[];
}): Promise<CodexCredentialScrubResult> {
  const removePaths = buildCredentialScrubPaths(input);
  const verifyPaths = [...new Set([...removePaths, ...(input.verifyPaths ?? [])])];
  const removedPaths: string[] = [];
  const failures: string[] = [];

  for (const path of removePaths) {
    try {
      await rm(path, { recursive: true, force: true });
      removedPaths.push(path);
    } catch (error) {
      failures.push(errorMessage(error));
    }
  }

  const remainingPaths: string[] = [];
  const verifiedAbsentPaths: string[] = [];
  for (const path of verifyPaths) {
    if (await pathExists(path)) {
      remainingPaths.push(path);
    } else {
      verifiedAbsentPaths.push(path);
    }
  }

  const ok = failures.length === 0 && remainingPaths.length === 0;
  return {
    ok,
    removedPaths,
    verifiedAbsentPaths,
    remainingPaths,
    ...(ok ? {} : { errorMessage: [...failures, remainingPaths.length ? "credential scrub verification failed" : ""].filter(Boolean).join("; ") }),
  };
}

async function scrubAndReport(input: {
  readonly bridge: Pick<ReturnType<typeof createBridgeRunner>, "runOnce">;
  readonly env: CodexRunnerEnvironment;
  readonly config: CodexRunnerConfig;
  readonly verifyPaths?: readonly string[];
}): Promise<CodexCredentialScrubResult> {
  const targetCount = buildCredentialScrubPaths(input).length + (input.verifyPaths?.length ?? 0);
  await input.bridge.runOnce({
    output: [
      securityOutput("credentials-scrub-started", {
        allowed: true,
        targetCount,
      }),
    ],
  });
  const result = await scrubCodexSandboxSecrets({
    env: input.env,
    config: input.config,
    verifyPaths: input.verifyPaths,
  });
  await input.bridge.runOnce({
    output: [
      securityOutput(result.ok ? "credentials-scrub-succeeded" : "credentials-scrub-failed", {
        allowed: result.ok,
        targetCount,
        verifiedCount: result.verifiedAbsentPaths.length,
        remainingCount: result.remainingPaths.length,
        ...(result.ok
          ? {}
          : {
              reason: "scrub-incomplete",
              errorMessage: redactKnownSecrets(result.errorMessage ?? "credential scrub verification failed", input.env),
            }),
      }),
    ],
  });
  return result;
}

function buildCredentialScrubPaths(input: {
  readonly env: CodexRunnerEnvironment;
  readonly config: Pick<CodexRunnerConfig, "codexHome"> & Partial<Pick<CodexRunnerConfig, "eventsPath" | "finalResponsePath">>;
}): readonly string[] {
  const home = input.env.HOME?.trim() || "/root";
  const paths = [
    input.config.codexHome,
    input.config.codexHome.includes("/agent-pool-codex/") ? dirname(input.config.codexHome) : null,
    input.config.finalResponsePath ?? null,
    input.config.eventsPath ?? null,
    join(home, ".codex"),
    join(home, ".config", "gh"),
    join(home, ".git-credentials"),
    join(home, ".netrc"),
    "/tmp/agent-pool-codex-proxy.env",
    "/tmp/agent-pool-github-token",
    "/tmp/agent-pool-gh-credentials",
    generatedAskpassPath(input.env.GIT_ASKPASS, home, input.config.codexHome),
  ];
  return [...new Set(paths.filter((path): path is string => Boolean(path)))];
}

function generatedAskpassPath(path: string | undefined, home: string, codexHome: string): string | null {
  const value = path?.trim();
  if (!value) return null;
  const codexSessionRoot = dirname(codexHome);
  if (value.startsWith("/tmp/") || value.startsWith(`${home}/`) || value.startsWith(`${codexSessionRoot}/`)) {
    return value;
  }
  return null;
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

function buildCodexArgs(config: CodexRunnerConfig, workspaceRoot: string, prompt: string): readonly string[] {
  const args = [
    "exec",
    "--ignore-user-config",
    "--cd",
    workspaceRoot,
    "--sandbox",
    "workspace-write",
    "--ask-for-approval",
    "never",
    "--json",
    "--ephemeral",
    "--output-last-message",
    config.finalResponsePath,
  ];
  if (config.model) {
    args.push("-m", config.model);
  }
  args.push(prompt);
  return args;
}

function buildCodexEnvironment(env: CodexRunnerEnvironment, config: CodexRunnerConfig): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const key of [
    "PATH",
    "HOME",
    "USER",
    "LANG",
    "LC_ALL",
    "TMPDIR",
    "GITHUB_TOKEN",
    "GIT_ASKPASS",
    "GIT_TERMINAL_PROMPT",
    "AGENT_POOL_GITHUB_TOKEN_ENV",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "NO_PROXY",
  ]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      output[key] = value;
    }
  }
  const apiKeyEnvName = env.AGENT_POOL_CODEX_API_KEY_ENV_NAME?.trim();
  if (apiKeyEnvName && apiKeyEnvName !== "CODEX_API_KEY" && env[apiKeyEnvName]) {
    output.CODEX_API_KEY = env[apiKeyEnvName] ?? "";
  } else if (typeof env.CODEX_API_KEY === "string") {
    output.CODEX_API_KEY = env.CODEX_API_KEY;
  }
  output.CODEX_HOME = config.codexHome;
  output.AGENT_POOL_CODEX_EVENTS_PATH = config.eventsPath;
  output.AGENT_POOL_DEPENDENCY_PHASE_COMPLETED = "1";
  output.AGENT_POOL_PACKAGE_EGRESS_MODE = "disabled-after-install";
  output.CI = output.CI || "1";
  return output;
}

function buildDependencyInstallEnvironment(env: CodexRunnerEnvironment): Readonly<Record<string, string>> {
  const output: Record<string, string> = {};
  for (const key of ["PATH", "HOME", "USER", "LANG", "LC_ALL", "TMPDIR", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"]) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) {
      output[key] = value;
    }
  }
  output.CI = "1";
  output.BUN_CONFIG_FROZEN_LOCKFILE = "1";
  output.AGENT_POOL_DEPENDENCY_PHASE = "install";
  return output;
}

function readCodexRunnerConfig(
  env: CodexRunnerEnvironment,
  session: BridgeSessionOptions,
  workspaceRoot: string,
): CodexRunnerConfig {
  const command = readCommand(env.AGENT_POOL_CODEX_COMMAND ?? "codex");
  const commandProfile = env.AGENT_POOL_CODEX_COMMAND_PROFILE?.trim() || AGENT_POOL_CODEX_COMMAND_PROFILE;
  if (commandProfile !== AGENT_POOL_CODEX_COMMAND_PROFILE) {
    throw new Error(`unsupported codex command profile: ${commandProfile}`);
  }
  const tempRoot = `/tmp/agent-pool-codex/${session.sessionId}`;
  const taskTitle = env.AGENT_POOL_TASK_TITLE?.trim() || `Agent Pool task ${session.taskId}`;

  return {
    command,
    commandProfile,
    model: env.AGENT_POOL_CODEX_MODEL?.trim() || null,
    codexHome: join(tempRoot, "codex-home"),
    finalResponsePath: join(tempRoot, "final-response.txt"),
    eventsPath: join(tempRoot, "codex-events.jsonl"),
    allowedEgressDomains: readCsv(env.AGENT_POOL_ALLOWED_EGRESS_DOMAINS),
    taskTitle,
    taskDescription: env.AGENT_POOL_TASK_DESCRIPTION?.trim() || null,
    repositoryUrl: env.AGENT_POOL_REPOSITORY_URL?.trim() || null,
    baseRef: env.AGENT_POOL_BASE_REF?.trim() || null,
    branchName: env.AGENT_POOL_TASK_BRANCH?.trim() || null,
  };

  function readCommand(value: string): string {
    const trimmed = value.trim();
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes("\0")) {
      throw new Error("AGENT_POOL_CODEX_COMMAND must be a single executable path or name");
    }
    return trimmed;
  }
}

function createRunnerProfileText(config: CodexRunnerConfig): string {
  return [
    `profile=${config.commandProfile}`,
    "allow=inspection commands: pwd ls find rg cat sed awk head tail wc sort uniq",
    "allow=git status diff log show branch checkout add commit push origin",
    "allow=bun install --frozen-lockfile; bun run typecheck; bun run test",
    "allow=gh pr create/view/status; gh repo view",
    "deny=rm -rf curl wget ssh scp docker kubectl terraform aws gh api gh secret gh auth token",
    config.allowedEgressDomains.length ? `egress=${config.allowedEgressDomains.join(",")}` : "egress=",
  ].join("\n");
}

async function writeCodexPolicyFiles(config: CodexRunnerConfig): Promise<void> {
  await mkdir(join(config.codexHome, "rules"), { recursive: true });
  const profile = createRunnerProfileText(config);
  await writeFile(join(config.codexHome, "agent-pool-command-profile.txt"), profile, "utf8");
  await writeFile(
    join(config.codexHome, "rules", "agent-pool-bun-pr.rules"),
    [
      "# Agent Pool command policy for codex exec.",
      "# Keep this file aligned with checkCodexCommandPolicy fixtures.",
      profile,
      "deny=pnpm yarn npm npx curl wget ssh scp docker kubectl terraform aws gh api gh secret gh auth token",
    ].join("\n"),
    "utf8",
  );
}

async function readFinalResponse(path: string, stdout: string, stderr: string): Promise<string> {
  const file = await readFile(path, "utf8").catch(() => "");
  const candidate = file.trim() || stdout.trim() || stderr.trim();
  return candidate || "Codex runner completed without a final message.";
}

async function readPullRequestUrlFromGh(input: {
  readonly executeProcess: CodexProcessExecutor;
  readonly env: CodexRunnerEnvironment;
  readonly config: CodexRunnerConfig;
  readonly workspaceRoot: string;
}): Promise<string | null> {
  const result = await input
    .executeProcess({
      command: "gh",
      args: ["pr", "view", "--json", "url", "--jq", ".url"],
      cwd: input.workspaceRoot,
      env: buildCodexEnvironment(input.env, input.config),
    })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return null;
  return extractPullRequestUrl(result.stdout) ?? extractPullRequestUrl(result.stderr);
}

async function enforceCommandSupervisorDecisions(input: {
  readonly decisions: readonly CodexCommandSupervisorDecision[];
  readonly bridge: Pick<ReturnType<typeof createBridgeRunner>, "runOnce">;
  readonly env: CodexRunnerEnvironment;
}): Promise<void> {
  for (const decision of input.decisions) {
    const metadata = commandDecisionMetadata(decision, input.env);
    await input.bridge.runOnce({ output: [securityOutput("command-policy", metadata)] });
    if (decision.kind === "denied") {
      throw new CodexCommandPolicyViolationError(decision);
    }
  }
}

function commandDecisionMetadata(
  decision: CodexCommandSupervisorDecision,
  env: CodexRunnerEnvironment,
): Readonly<Record<string, unknown>> {
  return {
    command: redactKnownSecrets(decision.commandText, env),
    policy: decision.policy,
    allowed: decision.kind === "allowed",
    ...(decision.kind === "denied" ? { reason: decision.reason } : {}),
  };
}

function untrustedContextMetadata(
  finding: UntrustedContextFinding,
  config: Pick<CodexRunnerConfig, "commandProfile" | "allowedEgressDomains">,
): Readonly<Record<string, unknown>> {
  return {
    source: finding.source,
    contextKind: finding.kind,
    allowed: finding.allowed,
    reason: finding.reasons.join(","),
    summary: finding.summary,
    policy: config.commandProfile,
    allowedEgressDomains: config.allowedEgressDomains,
  };
}

async function runCodexPostflight(input: {
  readonly executeProcess: CodexProcessExecutor;
  readonly env: CodexRunnerEnvironment;
  readonly config: CodexRunnerConfig;
  readonly workspaceRoot: string;
  readonly pullRequestUrl: string | null;
}): Promise<Readonly<Record<string, unknown>>> {
  const run = (command: string, args: readonly string[]) =>
    input
      .executeProcess({
        command,
        args,
        cwd: input.workspaceRoot,
        env: buildCodexEnvironment(input.env, input.config),
      })
      .catch((error) => ({ exitCode: 1, stdout: "", stderr: errorMessage(error) }));
  const [branch, headSha, statusShort, diffStat, changedFiles] = await Promise.all([
    run("git", ["rev-parse", "--abbrev-ref", "HEAD"]),
    run("git", ["rev-parse", "HEAD"]),
    run("git", ["status", "--short"]),
    run("git", ["diff", "--stat", "HEAD~1..HEAD"]),
    run("git", ["diff", "--name-only", "HEAD~1..HEAD"]),
  ]);
  const changedFileList = cleanProcessOutput(changedFiles.stdout)
    .split("\n")
    .map((value) => value.trim())
    .filter(Boolean);

  return {
    pullRequestUrl: input.pullRequestUrl,
    branch: cleanProcessOutput(branch.stdout),
    headSha: cleanProcessOutput(headSha.stdout),
    statusShort: cleanProcessOutput(statusShort.stdout),
    diffStat: cleanProcessOutput(diffStat.stdout),
    changedFiles: changedFileList,
    lockfileChanged: changedFileList.some((path) => path === "bun.lock" || path.endsWith("/bun.lock")),
    postflightOk: Boolean(input.pullRequestUrl) && branch.exitCode === 0 && headSha.exitCode === 0,
  };
}

async function readTrackedDependencyFiles(input: {
  readonly executeProcess: CodexProcessExecutor;
  readonly env: CodexRunnerEnvironment;
  readonly config: CodexRunnerConfig;
  readonly workspaceRoot: string;
}): Promise<readonly string[]> {
  const result = await input
    .executeProcess({
      command: "git",
      args: ["status", "--short", "--", "bun.lock", "bun.lockb", "package.json"],
      cwd: input.workspaceRoot,
      env: buildCodexEnvironment(input.env, input.config),
    })
    .catch(() => null);
  if (!result || result.exitCode !== 0) return [];
  return result.stdout
    .split("\n")
    .map((line) => line.slice(3).trim())
    .filter(Boolean);
}

function isLockfilePath(path: string): boolean {
  return path === "bun.lock" || path === "bun.lockb" || path.endsWith("/bun.lock") || path.endsWith("/bun.lockb");
}

function securityOutput(securityKind: string, metadata: Readonly<Record<string, unknown>>): BridgeRunnerOutputInput {
  return {
    stream: "system",
    text: `${JSON.stringify({ type: "security", securityKind, stage: securityStageForKind(securityKind), ...redactMetadata(metadata) })}\n`,
  };
}

function securityStageForKind(securityKind: string): "readiness" | "install" | "codex" | "pr" | "cleanup" {
  if (securityKind === "untrusted-context") return "readiness";
  if (securityKind === "package-registry" || securityKind === "package-install" || securityKind.startsWith("dependency-install")) return "install";
  if (securityKind === "postflight") return "pr";
  if (securityKind.startsWith("credentials-scrub")) return "cleanup";
  return "codex";
}

function redactMetadata(metadata: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> {
  return Object.fromEntries(
    Object.entries(metadata).map(([key, value]) => [
      key,
      /token|secret|password|key|proxy/i.test(key) ? "[REDACTED]" : value,
    ]),
  );
}

function isPackageInstallOutput(value: string): boolean {
  return /\bbun\s+install\b|Resolving dependencies|Downloaded and extracted/i.test(value);
}

function cleanupMetadata(
  reason: string,
  config: Pick<CodexRunnerConfig, "commandProfile">,
  metadata: Readonly<Record<string, unknown>>,
  scrubResult: CodexCredentialScrubResult,
): { readonly reason: string; readonly metadata: Readonly<Record<string, unknown>> } {
  return {
    reason,
    metadata: {
      runner: "codex",
      commandProfile: config.commandProfile,
      credentialsScrubbed: scrubResult.ok,
      credentialScrubStatus: scrubResult.ok ? "succeeded" : "failed",
      ...(scrubResult.ok
        ? {}
        : {
            credentialScrubRisk: "scrub-incomplete",
            credentialScrubRemainingCount: scrubResult.remainingPaths.length,
          }),
      ...metadata,
    },
  };
}

async function executeNodeProcess(input: CodexProcessExecutionInput): Promise<CodexProcessExecutionResult> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const child = spawn(input.command, [...input.args], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    const pending: Promise<unknown>[] = [];

    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(error);
    };

    const trackCallback = (callbackResult: void | Promise<void>) => {
      if (!callbackResult) return;
      pending.push(Promise.resolve(callbackResult).catch(fail));
    };

    child.stdout.on("data", (chunk) => {
      const text = chunk.toString();
      stdout.push(text);
      try {
        trackCallback(input.onStdout?.(text));
      } catch (error) {
        fail(error);
      }
    });
    child.stderr.on("data", (chunk) => {
      const text = chunk.toString();
      stderr.push(text);
      try {
        trackCallback(input.onStderr?.(text));
      } catch (error) {
        fail(error);
      }
    });
    child.on("error", fail);
    child.on("close", (code) => {
      Promise.allSettled(pending).then(() =>
        {
          if (settled) return;
          settled = true;
          resolve({
            exitCode: code ?? 1,
            stdout: stdout.join(""),
            stderr: stderr.join(""),
          });
        },
      );
    });
  });
}

function readProcessEnv(): CodexRunnerEnvironment {
  const processLike = globalThis as typeof globalThis & {
    process?: {
      env?: CodexRunnerEnvironment;
    };
  };

  return processLike.process?.env ?? {};
}

function readCsv(value: string | undefined): readonly string[] {
  return [
    ...new Set(
      (value ?? "")
        .split(",")
        .map((part) => part.trim().toLowerCase())
        .filter(Boolean),
    ),
  ];
}

function mergeProcessText(current: string, addition: string): string {
  if (!addition) return current;
  if (current.includes(addition)) return current;
  return `${current}${addition}`;
}

function cleanProcessOutput(value: string): string {
  return value.trim();
}

function truncate(value: string): string {
  return value.length <= 2000 ? value : `${value.slice(0, 2000)}...`;
}

function redactKnownSecrets(message: string, env: CodexRunnerEnvironment): string {
  let redacted = message;
  for (const [name, value] of Object.entries(env)) {
    if (!/(TOKEN|SECRET|PASSWORD|KEY|PROXY)/i.test(name) || !value || value.length < 6) continue;
    redacted = redacted.split(value).join("[REDACTED]");
  }
  return redacted;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
