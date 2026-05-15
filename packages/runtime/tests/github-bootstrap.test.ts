import { describe, expect, test } from "bun:test";

import { buildGitHubBootstrapPlan } from "../src";

describe("GitHub bootstrap plan", () => {
  test("builds clone fetch and task branch commands without token argv leakage", () => {
    const plan = buildGitHubBootstrapPlan({
      runtimeSource: {
        repositoryUrl: "https://github.com/example/tiny-fixture.git",
        baseRef: "main",
        taskBranchPrefix: "agent-pool/task",
      },
      taskId: "task_123",
      workingDirectory: "/workspace/agent-pool",
      githubTokenEnvName: "GITHUB_TOKEN",
      githubTokenConfigured: true,
    });

    expect(plan).toEqual({
      repositoryUrl: "https://github.com/example/tiny-fixture.git",
      baseRef: "main",
      branchName: "agent-pool/task/task_123",
      workingDirectory: "/workspace/agent-pool",
      commands: [
        {
          label: "prepare repository",
          command: [
            "sh",
            "-lc",
            "if [ -e /workspace/agent-pool ] && [ ! -d /workspace/agent-pool/.git ]; then   echo 'working directory exists but is not a git repository'; exit 1; fi; if [ ! -d /workspace/agent-pool/.git ]; then   git clone --no-checkout https://github.com/example/tiny-fixture.git /workspace/agent-pool; fi",
          ],
        },
        {
          label: "fetch base ref",
          command: ["git", "-C", "/workspace/agent-pool", "fetch", "--depth", "1", "origin", "main"],
        },
        {
          label: "create task branch",
          command: ["git", "-C", "/workspace/agent-pool", "checkout", "-B", "agent-pool/task/task_123", "FETCH_HEAD"],
        },
      ],
      environment: {
        variables: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_ASKPASS: "/agent-pool/bin/github-token-askpass",
          AGENT_POOL_GITHUB_TOKEN_ENV: "GITHUB_TOKEN",
        },
        secretEnvNames: ["GITHUB_TOKEN"],
      },
    });
    expect(JSON.stringify(plan.commands)).not.toContain("github-secret");
    expect(JSON.stringify(plan.commands)).not.toContain("GITHUB_TOKEN");
  });

  test("normalizes branch task ids and rejects invalid bootstrap inputs", () => {
    expect(
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "feature/ref",
          taskBranchPrefix: "agent-pool/task/",
        },
        taskId: "Task 123!",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: true,
      }).branchName,
    ).toBe("agent-pool/task/Task-123");

    expect(() =>
      buildGitHubBootstrapPlan({
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: true,
      }),
    ).toThrow("github bootstrap requires runtime source metadata");
    expect(() =>
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "git@github.com:example/tiny-fixture.git",
          baseRef: "main",
          taskBranchPrefix: "agent-pool/task",
        },
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: true,
      }),
    ).toThrow("https GitHub repository URL");
    expect(() =>
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "../main",
          taskBranchPrefix: "agent-pool/task",
        },
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: true,
      }),
    ).toThrow("baseRef is invalid");
    expect(() =>
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "main",
          taskBranchPrefix: "ghp_secret",
        },
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: true,
      }),
    ).toThrow("must not contain secret values");
    expect(() =>
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "main",
          taskBranchPrefix: "agent-pool/task",
        },
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenEnvName: "github-token",
        githubTokenConfigured: true,
      }),
    ).toThrow("token env name is invalid");
    expect(() =>
      buildGitHubBootstrapPlan({
        runtimeSource: {
          repositoryUrl: "https://github.com/example/tiny-fixture.git",
          baseRef: "main",
          taskBranchPrefix: "agent-pool/task",
        },
        taskId: "task_123",
        workingDirectory: "/workspace/agent-pool",
        githubTokenConfigured: false,
      }),
    ).toThrow("GITHUB_TOKEN is required for github bootstrap");
  });
});
