// Claude CLI adapter — implements AgentAdapter for the `claude` CLI

import { mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync } from 'fs';
import { join, dirname } from 'path';
import type { AgentAdapter, AgentContext } from './agent.js';
import type { GitClient } from '../git/interfaces.js';

const DOC_RULES_MARKER = '## Documentation Rules';

const DOC_RULES = `
## Documentation Rules — IMPORTANT

NEVER create documentation, design docs, plans, reviews, or markdown files inside the repository tree.
ALL non-code documentation must go in one of these locations:

- \`agent-docs/\` — YOUR private workspace for this task (plans, todos, notes, reviews)
  Example: agent-docs/todo.md, agent-docs/implementation-plan.md
- \`shared-docs/\` — shared across all agents (lessons learned, architecture decisions)
  Example: shared-docs/lessons.md

These are symlinked to a persistent store outside the repo. They survive clone refreshes and are visible to the orchestrator.

Do NOT write .md files to paths like documentation/, docs/, design/, state/, etc. within the repo.
Code comments and inline docs in source files are fine — this rule is about standalone documentation files.
`;

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
bun run "$AGENT_POOL_TOOL_DIR/src/finish-task.ts" $ARGUMENTS
\`\`\`

3. After the script succeeds, print a brief confirmation message including the PR URL if one was created.

4. **IMPORTANT**: After confirming, you are DONE. Do not do any more work. Do not ask follow-up questions. Simply stop responding so the session can end.
`;

export class ClaudeAdapter implements AgentAdapter {
  constructor(private git: GitClient) {}

  async setup(ctx: AgentContext): Promise<void> {
    // 1. Checkout fresh branch from origin/{branch}
    await this.git.fetch(ctx.clonePath);
    const localBranch = `${ctx.agentId}-${ctx.taskId}`;
    await this.git.createBranch(ctx.clonePath, localBranch, `origin/${ctx.branch}`);

    // 2. Fix origin remote if it's a local path
    const originUrl = await this.git.getRemoteUrl(ctx.clonePath);
    if (originUrl && originUrl.startsWith('/')) {
      const sourceRemote = await this.git.getRemoteUrl(originUrl);
      if (sourceRemote) {
        await this.git.setRemoteUrl(ctx.clonePath, sourceRemote);
      }
    }

    // 3. Install hooks into .claude/settings.json
    this.installHooks(ctx);

    // 4. Setup docs directories
    this.setupDocs(ctx);

    // 5. Install /finish command
    this.installFinishCommand(ctx);

    // 6. Install /update and /dispatch slash commands
    this.installSlashCommands(ctx);

    // 7. Append doc rules to CLAUDE.md
    this.appendDocRules(ctx);

    // 8. Update .gitignore
    this.updateGitignore(ctx);
  }

  private proc: ReturnType<typeof Bun.spawn> | null = null;

  async run(ctx: AgentContext): Promise<number> {
    const prompt = this.buildPrompt(ctx);
    const claudeArgs = ['claude', prompt];
    if (ctx.skipPermissions) {
      claudeArgs.push('--dangerously-skip-permissions');
    }

    const env: Record<string, string> = {
      ...(process.env as Record<string, string>),
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
    const logDir = join(ctx.dataDir, 'logs', ctx.agentId);
    mkdirSync(logDir, { recursive: true });
    this.rotateLogFiles(logDir, 20);
    const logPath = join(logDir, `${ctx.taskId}.log`);

    const args = this.buildScriptArgs(claudeArgs, logPath);

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
    if (process.platform === 'darwin') {
      // macOS: script -q <file> <cmd...>
      return ['script', '-q', logPath, ...claudeArgs];
    } else {
      // Linux: script -qc "<cmd...>" <file>
      const cmdStr = claudeArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
      return ['script', '-qc', cmdStr, logPath];
    }
  }

  /** Keep only the most recent maxLogs files per agent log directory. */
  private rotateLogFiles(logDir: string, maxLogs: number): void {
    try {
      const files = readdirSync(logDir)
        .filter(f => f.endsWith('.log'))
        .map(f => ({ name: f, path: join(logDir, f) }));

      if (files.length <= maxLogs) return;

      // Sort by mtime, oldest first
      files.sort((a, b) => {
        const aStat = Bun.file(a.path).lastModified;
        const bStat = Bun.file(b.path).lastModified;
        return aStat - bStat;
      });

      const toDelete = files.slice(0, files.length - maxLogs);
      for (const f of toDelete) {
        unlinkSync(f.path);
      }
    } catch {
      // best-effort rotation
    }
  }

  buildPrompt(ctx: AgentContext): string {
    let prompt = '';
    if (ctx.trackingContext) prompt += ctx.trackingContext + '\n';
    if (ctx.workflowContext) prompt += ctx.workflowContext + '\n';
    prompt += ctx.prompt;
    return prompt;
  }

  private installHooks(ctx: AgentContext): void {
    const settingsFile = join(ctx.clonePath, '.claude', 'settings.json');
    mkdirSync(dirname(settingsFile), { recursive: true });

    const mailboxHook = {
      type: 'command',
      command: `${ctx.toolDir}/hooks/mailbox-hook.sh`,
      timeout: 5000,
    };
    const approvalHook = {
      type: 'command',
      command: `${ctx.toolDir}/hooks/approval-hook.sh`,
      timeout: 310000,
    };

    const hooks = ctx.skipPermissions
      ? [mailboxHook]
      : [mailboxHook, approvalHook];

    const hookEntry = { hooks };

    let settings: Record<string, unknown> = {};
    if (existsSync(settingsFile)) {
      try {
        settings = JSON.parse(readFileSync(settingsFile, 'utf-8'));
      } catch {
        // corrupted file, start fresh
      }
    }

    // Ensure hooks structure exists
    if (!settings.hooks || typeof settings.hooks !== 'object') {
      settings.hooks = {};
    }
    const hooksObj = settings.hooks as Record<string, unknown[]>;
    if (!Array.isArray(hooksObj.PreToolUse)) {
      hooksObj.PreToolUse = [];
    }

    // Remove existing agent-pool hooks to avoid duplicates
    hooksObj.PreToolUse = hooksObj.PreToolUse.filter((entry: unknown) => {
      const e = entry as { hooks?: Array<{ command?: string }> };
      if (!e.hooks) return true;
      return !e.hooks.some(
        (h) =>
          h.command &&
          (h.command.includes('approval-hook.sh') ||
            h.command.includes('mailbox-hook.sh')),
      );
    });

    // Add our hooks
    hooksObj.PreToolUse.push(hookEntry);

    writeFileSync(settingsFile, JSON.stringify(settings, null, 2));
  }

  private setupDocs(ctx: AgentContext): void {
    const agentDocsSource = join(ctx.dataDir, 'docs', 'agents', ctx.agentId);
    const sharedDocsSource = join(ctx.dataDir, 'docs', 'shared');
    const agentDocsLink = join(ctx.clonePath, 'agent-docs');
    const sharedDocsLink = join(ctx.clonePath, 'shared-docs');

    // Create source directories
    mkdirSync(agentDocsSource, { recursive: true });
    mkdirSync(sharedDocsSource, { recursive: true });

    // Create symlinks (remove existing first)
    for (const [source, link] of [
      [agentDocsSource, agentDocsLink],
      [sharedDocsSource, sharedDocsLink],
    ]) {
      try {
        unlinkSync(link);
      } catch {
        // doesn't exist, fine
      }
      symlinkSync(source, link);
    }
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

  private updateGitignore(ctx: AgentContext): void {
    const gitignorePath = join(ctx.clonePath, '.gitignore');
    const entries = ['agent-docs', 'shared-docs', 'CLAUDE.md', '.claude/commands/finish.md', '.claude/commands/update.md', '.claude/commands/dispatch.md'];

    let content = '';
    if (existsSync(gitignorePath)) {
      content = readFileSync(gitignorePath, 'utf-8');
    }

    const lines = content.split('\n');
    let modified = false;
    for (const entry of entries) {
      if (!lines.includes(entry)) {
        lines.push(entry);
        modified = true;
      }
    }

    if (modified) {
      writeFileSync(gitignorePath, lines.join('\n'));
    }
  }
}
