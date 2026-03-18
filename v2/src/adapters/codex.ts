// Codex CLI adapter — implements AgentAdapter for the `codex` CLI

import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import type { AgentAdapter, AgentContext } from './agent.js';
import type { GitClient } from '../git/interfaces.js';
import {
  DOC_RULES,
  checkoutTaskBranch,
  setupDocs,
  updateGitignore,
  setupOutputCapture,
  buildScriptArgs,
  buildPromptWithContext,
} from './base-setup.js';

const AGENTS_MD_TEMPLATE = (toolDir: string) => `${DOC_RULES}
## Finishing a Task

When your task is complete:

1. Commit your changes on the current branch
2. Push the branch: \`git push -u origin $(git branch --show-current)\`
3. Create a PR: \`gh pr create --title "Brief description" --body "What changed and why"\`
4. If your workflow instructions mention auto-merge: \`gh pr merge --auto --squash\`
5. Run the finish script:

\`\`\`bash
bun run "${toolDir}/src/finish-task.ts" completed
\`\`\`
`;

export class CodexAdapter implements AgentAdapter {
  constructor(private git: GitClient) {}

  private proc: ReturnType<typeof Bun.spawn> | null = null;

  async setup(ctx: AgentContext): Promise<void> {
    // 1. Checkout fresh branch from origin/{branch}
    await checkoutTaskBranch(this.git, ctx);

    // 2. Setup docs directories
    setupDocs(ctx);

    // 3. Write AGENTS.md with doc rules + finish instructions
    const agentsMdPath = join(ctx.clonePath, 'AGENTS.md');
    writeFileSync(agentsMdPath, AGENTS_MD_TEMPLATE(ctx.toolDir));

    // 4. Update .gitignore
    updateGitignore(ctx, ['agent-docs', 'shared-docs', 'AGENTS.md']);
  }

  async run(ctx: AgentContext): Promise<number> {
    const prompt = this.buildPrompt(ctx);
    const codexArgs = ctx.skipPermissions
      ? ['codex', 'exec', '--full-auto', prompt]
      : ['codex', 'exec', prompt];

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
    const { logPath } = setupOutputCapture(ctx.agentId, ctx.dataDir, ctx.taskId);
    const args = buildScriptArgs(codexArgs, logPath);

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

  buildPrompt(ctx: AgentContext): string {
    return buildPromptWithContext(ctx);
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

  getLogPath(ctx: AgentContext): string {
    return join(ctx.dataDir, 'logs', ctx.agentId, `${ctx.taskId}.log`);
  }
}
