import { describe, expect, test } from "bun:test";

import { createCodexCommandSupervisor, inspectCodexEventLine, parseCommandText } from "../src/command-supervisor";

describe("Codex command supervisor", () => {
  test("allows command events that match the command profile", () => {
    const supervisor = createCodexCommandSupervisor({ commandProfile: "agent-pool-bun-pr" });

    const decisions = supervisor.inspectChunk('{"type":"command.started","command":"bun run test"}\n');

    expect(decisions).toEqual([
      {
        kind: "allowed",
        command: ["bun", "run", "test"],
        commandText: "bun run test",
        policy: "agent-pool-bun-pr",
      },
    ]);
  });

  test("fails closed for shell compounds and partial JSON chunks", () => {
    const supervisor = createCodexCommandSupervisor({ commandProfile: "agent-pool-bun-pr" });

    expect(supervisor.inspectChunk('{"type":"command.started",')).toEqual([]);
    const decisions = supervisor.inspectChunk('"command":"cd repo && curl https://example.test"}\n');

    expect(decisions).toEqual([
      {
        kind: "denied",
        command: [],
        commandText: "cd repo && curl https://example.test",
        policy: "agent-pool-bun-pr",
        reason: "compound_shell_forbidden",
      },
    ]);
  });

  test("denies task branch mismatches before postflight", () => {
    const decisions = inspectCodexEventLine('{"type":"exec_command","command":["git","push","origin","main"]}', {
      commandProfile: "agent-pool-bun-pr",
      expectedBranchName: "agent-pool/task/task_1",
    });

    expect(decisions).toEqual([
      {
        kind: "denied",
        command: ["git", "push", "origin", "main"],
        commandText: "git push origin main",
        policy: "agent-pool-bun-pr",
        reason: "git_push_protected_branch_forbidden",
      },
    ]);
  });

  test("parses quoted commands and ignores non-command events", () => {
    expect(parseCommandText('gh pr create --title "demo task"')).toEqual(["gh", "pr", "create", "--title", "demo task"]);
    expect(inspectCodexEventLine('{"type":"assistant.message","text":"hello"}', { commandProfile: "agent-pool-bun-pr" })).toEqual([]);
  });
});
