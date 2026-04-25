// Claude CLI adapter — implements AgentAdapter for the `claude` CLI

import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import type { AgentAdapter, AgentContext } from './agent.js';
import type { GitClient } from '../git/interfaces.js';
import {
  DOC_RULES,
  DOC_RULES_MARKER,
  checkoutTaskBranch,
  setupDocs,
  updateGitignore,
  setupOutputCapture,
  buildScriptArgs,
  buildPromptWithContext,
} from './base-setup.js';

const FINISH_COMMAND = `---
description: "Mark the current agent-pool task with a status and end the session"
argument-hint: "[completed|blocked|pending|backlogged]"
allowed-tools: ["Bash"]
---

# Finish Task

Run the finish-task script to mark this task and end the session. The status defaults to \`completed\` if not specified.

**Valid statuses:** \`completed\`, \`blocked\`, \`pending\` (retry), \`backlogged\`

## Steps

1. If you created a PR with \`gh pr create\` and your workflow instructions mention auto-merge, enable it now:

\`\`\`bash
gh pr merge --auto --squash
\`\`\`

Use the merge method specified in your workflow instructions (squash, merge, or rebase). If this fails, log a warning (e.g. "Auto-merge not available for this repo") and continue — do not block the task.

2. Run the finish script:

\`\`\`bash
bun run "$AGENT_POOL_TOOL_DIR/v2/src/finish-task.ts" $ARGUMENTS
\`\`\`

3. After the script succeeds, print a brief confirmation message including the PR URL if one was created.

4. **IMPORTANT**: After confirming, you are DONE. Do not do any more work. Do not ask follow-up questions. Simply stop responding so the session can end.
`;

export class ClaudeAdapter implements AgentAdapter {
  constructor(private git: GitClient) {}

  async setup(ctx: AgentContext): Promise<void> {
    // 1. Checkout fresh branch from origin/{branch}
    await checkoutTaskBranch(this.git, ctx);

    // 2. Setup docs directories
    setupDocs(ctx);

    // 3. Install /finish command
    this.installFinishCommand(ctx);

    // 4. Install /update and /dispatch slash commands
    this.installSlashCommands(ctx);

    // 5. Append doc rules to CLAUDE.md
    this.appendDocRules(ctx);

    // 6. Update .gitignore
    updateGitignore(ctx, ['agent-docs', 'shared-docs', 'CLAUDE.md', '.claude/commands/finish.md', '.claude/commands/update.md', '.claude/commands/dispatch.md']);
  }

  private proc: ReturnType<typeof Bun.spawn> | null = null;

  async run(ctx: AgentContext): Promise<number> {
    const prompt = this.buildPrompt(ctx);
    const claudeArgs = ['ccc', prompt];
    if (ctx.skipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...(ctx.envVars ?? {}),
      AGENT_POOL_TASK_ID: ctx.taskId,
      AGENT_POOL_PROJECT: ctx.projectName,
      AGENT_POOL_DATA_DIR: ctx.dataDir,
      AGENT_POOL_TOOL_DIR: ctx.toolDir,
      AGENT_POOL_AGENT_ID: ctx.agentId,
    };
    if (ctx.envName) {
      env.ENV = ctx.envName;
    }

    // Set up output capture via `script`
    const { logPath } = setupOutputCapture(ctx.agentId, ctx.dataDir, ctx.taskId);

    const args = buildScriptArgs(claudeArgs, logPath);

    this.proc = Bun.spawn(args, {
      cwd: ctx.clonePath,
      env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    });

    const exitCode = await this.proc.exited;
    this.proc = null;
    return exitCode;
  }

  /** Get the log path for a task run. */
  getLogPath(ctx: AgentContext): string {
    return join(ctx.dataDir, 'logs', ctx.agentId, `${ctx.taskId}.log`);
  }

  abort(): void {
    if (this.proc) {
      this.proc.kill('SIGTERM');
    }
  }

  forceKill(): void {
    if (this.proc) {
      this.proc.kill('SIGKILL');
    }
  }

  /** Build `script` command args for output capture (platform-aware). */
  buildScriptArgs(claudeArgs: string[], logPath: string): string[] {
    return buildScriptArgs(claudeArgs, logPath);
  }

  buildPrompt(ctx: AgentContext): string {
    return buildPromptWithContext(ctx);
  }

  private installFinishCommand(ctx: AgentContext): void {
    const commandsDir = join(ctx.clonePath, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });
    writeFileSync(join(commandsDir, 'finish.md'), FINISH_COMMAND);
  }

  private installSlashCommands(ctx: AgentContext): void {
    const commandsDir = join(ctx.clonePath, '.claude', 'commands');
    mkdirSync(commandsDir, { recursive: true });

    for (const name of ['update.md', 'dispatch.md']) {
      const src = join(ctx.toolDir, 'commands', name);
      if (existsSync(src)) {
        writeFileSync(join(commandsDir, name), readFileSync(src, 'utf-8'));
      }
    }
  }

  private appendDocRules(ctx: AgentContext): void {
    const claudeMd = join(ctx.clonePath, 'CLAUDE.md');
    if (existsSync(claudeMd)) {
      const content = readFileSync(claudeMd, 'utf-8');
      if (content.includes(DOC_RULES_MARKER)) return;
      writeFileSync(claudeMd, content + DOC_RULES);
    } else {
      writeFileSync(claudeMd, DOC_RULES);
    }
  }
}
