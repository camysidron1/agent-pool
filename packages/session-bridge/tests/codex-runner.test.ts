import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCodexBridgeSession, scrubCodexSandboxSecrets, type CodexProcessExecutor } from "../src/codex-runner";
import type { BridgeCallbackEvent, BridgeSessionOptions } from "../src";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("Codex bridge runner", () => {
  test("streams codex output, requires a PR URL, posts completion, and scrubs credentials", async () => {
    const workspaceRoot = await tempDir("agent-pool-codex-runner-");
    const events: BridgeCallbackEvent[] = [];
    const commands: Array<{ readonly command: string; readonly args: readonly string[]; readonly env: Readonly<Record<string, string>> }> = [];
    const executeProcess: CodexProcessExecutor = async (input) => {
      commands.push({ command: input.command, args: input.args, env: input.env });
      if (input.command === "bun") {
        expect(input.args).toEqual(["install", "--frozen-lockfile"]);
        expect(input.env.AGENT_POOL_DEPENDENCY_PHASE).toBe("install");
        expect(input.env.BUN_CONFIG_FROZEN_LOCKFILE).toBe("1");
        expect(input.env.CODEX_API_KEY).toBeUndefined();
        expect(input.env.GITHUB_TOKEN).toBeUndefined();
        await input.onStdout?.("Resolving dependencies\nDownloaded and extracted [1]\n");
        return { exitCode: 0, stdout: "Resolving dependencies\n", stderr: "" };
      }
      if (input.command === "codex") {
        const outputPath = readArgValue(input.args, "--output-last-message");
        expect(input.args).toContain("--json");
        expect(input.args).toContain("--ephemeral");
        expect(input.args).toContain("--ignore-user-config");
        expect(input.args).not.toContain("--ignore-rules");
        expect(input.args).toContain("--sandbox");
        expect(input.env.CODEX_HOME).toContain("/tmp/agent-pool-codex/session_1/codex-home");
        expect(input.env.GITHUB_TOKEN).toBe("short-lived-github-token");
        expect(input.env.CODEX_API_KEY).toBe("codex-secret");
        expect(input.env.AGENT_POOL_DEPENDENCY_PHASE_COMPLETED).toBe("1");
        expect(input.env.AGENT_POOL_PACKAGE_EGRESS_MODE).toBe("disabled-after-install");
        expect(input.env.UNRELATED_SECRET).toBeUndefined();
        await mkdir(join(input.env.CODEX_HOME, "state"), { recursive: true });
        await writeFile(join(input.env.CODEX_HOME, "state", "auth.json"), "secret", "utf8");
        expect(existsSync(join(input.env.CODEX_HOME, "rules", "agent-pool-bun-pr.rules"))).toBe(true);
        await writeFile(outputPath, "Opened PR https://github.com/example/tiny-fixture/pull/123", "utf8");
        await input.onStdout?.("{\"type\":\"command.started\",\"command\":\"bun run test\"}\n");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.command === "git" && input.args[0] === "rev-parse" && input.args[1] === "--abbrev-ref") {
        return { exitCode: 0, stdout: "agent-pool/task/task_1\n", stderr: "" };
      }
      if (input.command === "git" && input.args[0] === "rev-parse") {
        return { exitCode: 0, stdout: "abc123\n", stderr: "" };
      }
      if (input.command === "git" && input.args[0] === "status") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.command === "git" && input.args[0] === "diff") {
        return { exitCode: 0, stdout: "1 file changed\n", stderr: "" };
      }
      if (input.command === "gh") {
        return { exitCode: 0, stdout: "https://github.com/example/tiny-fixture/pull/123\n", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "unexpected command" };
    };

    const result = await runCodexBridgeSession({
      session: bridgeSession(),
      workspaceRoot,
      env: runnerEnv({ HOME: workspaceRoot }),
      fetch: collectBridgeEvents(events),
      executeProcess,
    });

    expect(result.ok).toBe(true);
    expect(result.pullRequestUrl).toBe("https://github.com/example/tiny-fixture/pull/123");
    expect(events.map((event) => event.kind)).toContain("final_response");
    expect(events.map((event) => event.kind)).toContain("completion");
    expect(events.map((event) => event.kind)).toContain("cleanup");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("command.started");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("dependency-install-started");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("dependency-install-finished");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("package-install");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("command-policy");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("credentials-scrub-started");
    expect(events.filter((event) => event.kind === "output").map((event) => event.text).join("\n")).toContain("credentials-scrub-succeeded");
    expect(JSON.stringify(events)).not.toContain("short-lived-github-token");
    expect(JSON.stringify(events)).not.toContain("codex-secret");
    expect(JSON.stringify(events)).not.toContain("bridge-token");
    expect(existsSync("/tmp/agent-pool-codex/session_1/codex-home")).toBe(false);
    expect(commands.find((command) => command.command === "codex")?.args.join(" ")).toContain("A pull request URL is required for success");
  });

  test("fails sessions when codex exits successfully without a PR URL", async () => {
    const workspaceRoot = await tempDir("agent-pool-codex-missing-pr-");
    const events: BridgeCallbackEvent[] = [];
    const executeProcess: CodexProcessExecutor = async (input) => {
      if (input.command === "bun") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.command === "codex") {
        await writeFile(readArgValue(input.args, "--output-last-message"), "Done without PR", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 1, stdout: "", stderr: "" };
    };

    const result = await runCodexBridgeSession({
      session: bridgeSession(),
      workspaceRoot,
      env: runnerEnv({ HOME: workspaceRoot }),
      fetch: collectBridgeEvents(events),
      executeProcess,
    });

    expect(result.ok).toBe(false);
    expect(result.pullRequestUrl).toBeNull();
    expect(events).toContainEqual(expect.objectContaining({ kind: "failure", errorMessage: "codex runner completed without a pull request URL" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "cleanup" }));
  });

  test("fails before codex execution when frozen dependency install fails", async () => {
    const workspaceRoot = await tempDir("agent-pool-codex-install-fail-");
    const events: BridgeCallbackEvent[] = [];
    const commands: string[] = [];
    const executeProcess: CodexProcessExecutor = async (input) => {
      commands.push(input.command);
      if (input.command === "bun") {
        await input.onStderr?.("lockfile had changes\n");
        return { exitCode: 1, stdout: "", stderr: "lockfile had changes" };
      }
      if (input.command === "git") {
        return { exitCode: 0, stdout: " M bun.lock\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCodexBridgeSession({
      session: bridgeSession(),
      workspaceRoot,
      env: runnerEnv({ HOME: workspaceRoot }),
      fetch: collectBridgeEvents(events),
      executeProcess,
    });

    expect(result.ok).toBe(false);
    expect(commands).toContain("bun");
    expect(commands).not.toContain("codex");
    expect(events).toContainEqual(expect.objectContaining({ kind: "failure", errorMessage: "dependency install phase failed before codex execution" }));
    const output = events.filter((event) => event.kind === "output").map((event) => event.text).join("\n");
    expect(output).toContain("dependency-install-failed");
    expect(output).toContain("lockfileChanged");
    expect(JSON.stringify(events)).not.toContain("short-lived-github-token");
  });

  test("fails closed when codex emits a forbidden command event", async () => {
    const workspaceRoot = await tempDir("agent-pool-codex-policy-deny-");
    const events: BridgeCallbackEvent[] = [];
    const commands: string[] = [];
    const executeProcess: CodexProcessExecutor = async (input) => {
      commands.push(input.command);
      if (input.command === "bun") {
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.command === "codex") {
        await input.onStdout?.('{"type":"command.started","command":"curl https://example.test"}\n');
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };

    const result = await runCodexBridgeSession({
      session: bridgeSession(),
      workspaceRoot,
      env: runnerEnv({ HOME: workspaceRoot }),
      fetch: collectBridgeEvents(events),
      executeProcess,
    });

    expect(result.ok).toBe(false);
    expect(commands).toEqual(["bun", "git", "codex"]);
    expect(events).toContainEqual(expect.objectContaining({ kind: "failure", errorMessage: "codex runner failed: command policy denied: curl_forbidden" }));
    expect(events).toContainEqual(expect.objectContaining({ kind: "cleanup" }));
    const output = events.filter((event) => event.kind === "output").map((event) => event.text).join("\n");
    expect(output).toContain("command-policy");
    expect(output).toContain('"allowed":false');
    expect(output).toContain("curl_forbidden");
    expect(JSON.stringify(events)).not.toContain("short-lived-github-token");
  });

  test("scrubs Codex, GitHub CLI, and proxy credential files before snapshot cleanup", async () => {
    const root = await tempDir("agent-pool-codex-scrub-");
    const codexHome = join(root, "codex-home");
    const finalResponsePath = join(root, "final-response.txt");
    const eventsPath = join(root, "codex-events.jsonl");
    const askpassPath = join(root, "generated-askpass");
    await mkdir(join(codexHome, "state"), { recursive: true });
    await mkdir(join(root, ".config", "gh"), { recursive: true });
    await mkdir(join(root, ".codex"), { recursive: true });
    await writeFile(join(codexHome, "state", "auth.json"), "secret", "utf8");
    await writeFile(join(root, ".config", "gh", "hosts.yml"), "secret", "utf8");
    await writeFile(join(root, ".codex", "auth.json"), "secret", "utf8");
    await writeFile(finalResponsePath, "secret", "utf8");
    await writeFile(eventsPath, "secret", "utf8");
    await writeFile(askpassPath, "secret", "utf8");

    const result = await scrubCodexSandboxSecrets({
      env: { HOME: root, GIT_ASKPASS: askpassPath },
      config: { codexHome, finalResponsePath, eventsPath },
    });

    expect(result.ok).toBe(true);
    expect(existsSync(codexHome)).toBe(false);
    expect(existsSync(join(root, ".config", "gh"))).toBe(false);
    expect(existsSync(join(root, ".codex"))).toBe(false);
    expect(existsSync(finalResponsePath)).toBe(false);
    expect(existsSync(eventsPath)).toBe(false);
    expect(existsSync(askpassPath)).toBe(false);
  });

  test("records scrub failure events without blocking cleanup callbacks", async () => {
    const workspaceRoot = await tempDir("agent-pool-codex-scrub-fail-");
    const events: BridgeCallbackEvent[] = [];
    const persistentCredentialPath = join(workspaceRoot, "mounted-credential");
    await writeFile(persistentCredentialPath, "short-lived-github-token", "utf8");
    const executeProcess: CodexProcessExecutor = async (input) => {
      if (input.command === "bun") return { exitCode: 0, stdout: "", stderr: "" };
      if (input.command === "codex") {
        await writeFile(readArgValue(input.args, "--output-last-message"), "Opened PR https://github.com/example/tiny-fixture/pull/123", "utf8");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      if (input.command === "gh") return { exitCode: 0, stdout: "https://github.com/example/tiny-fixture/pull/123\n", stderr: "" };
      return { exitCode: 0, stdout: "agent-pool/task/task_1\n", stderr: "" };
    };

    const result = await runCodexBridgeSession({
      session: bridgeSession(),
      workspaceRoot,
      env: runnerEnv({ HOME: workspaceRoot }),
      fetch: collectBridgeEvents(events),
      executeProcess,
      credentialScrubVerificationPaths: [persistentCredentialPath],
    });

    expect(result.ok).toBe(true);
    const output = events.filter((event) => event.kind === "output").map((event) => event.text).join("\n");
    expect(output).toContain("credentials-scrub-started");
    expect(output).toContain("credentials-scrub-failed");
    expect(output).toContain('"allowed":false');
    expect(output).toContain("scrub-incomplete");
    const cleanup = events.find((event) => event.kind === "cleanup");
    expect(cleanup).toMatchObject({
      kind: "cleanup",
      metadata: {
        credentialsScrubbed: false,
        credentialScrubStatus: "failed",
        credentialScrubRisk: "scrub-incomplete",
      },
    });
    expect(JSON.stringify(events)).not.toContain("short-lived-github-token");
  });
});

function bridgeSession(): BridgeSessionOptions {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://bridge.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "bridge-token",
    },
    workspaceRoot: "/workspace/agent-pool",
  };
}

function runnerEnv(extra: Readonly<Record<string, string>> = {}): Readonly<Record<string, string>> {
  return {
    AGENT_POOL_BRIDGE_RUNNER: "codex",
    AGENT_POOL_CODEX_COMMAND: "codex",
    AGENT_POOL_CODEX_COMMAND_PROFILE: "agent-pool-bun-pr",
    AGENT_POOL_TASK_TITLE: "Make a PR",
    AGENT_POOL_TASK_DESCRIPTION: "Use the real runner",
    AGENT_POOL_REPOSITORY_URL: "https://github.com/example/tiny-fixture.git",
    AGENT_POOL_BASE_REF: "main",
    AGENT_POOL_TASK_BRANCH: "agent-pool/task/task_1",
    AGENT_POOL_ALLOWED_EGRESS_DOMAINS: "github.com,api.github.com,registry.npmjs.org,api.openai.com",
    GITHUB_TOKEN: "short-lived-github-token",
    CODEX_API_KEY: "codex-secret",
    UNRELATED_SECRET: "must-not-inherit",
    ...extra,
  };
}

function collectBridgeEvents(events: BridgeCallbackEvent[]): typeof fetch {
  return (async (url, init) => {
    const path = new URL(String(url)).pathname;
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    if (path === "/steering/poll") {
      return jsonResponse({ ok: true, messages: [] });
    }
    if (path === "/steering/report") {
      return jsonResponse({ ok: true });
    }
    events.push(body as BridgeCallbackEvent);
    return jsonResponse({ ok: true });
  }) as typeof fetch;
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function readArgValue(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  if (index < 0 || !args[index + 1]) throw new Error(`missing ${name}`);
  return args[index + 1] ?? "";
}

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  cleanupPaths.push(dir);
  return dir;
}
