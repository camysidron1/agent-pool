// Shared setup utilities for agent adapters

import { mkdirSync, existsSync, readFileSync, writeFileSync, symlinkSync, unlinkSync, readdirSync } from 'fs';
import { join } from 'path';
import type { AgentContext } from './agent.js';
import type { GitClient } from '../git/interfaces.js';

export const DOC_RULES_MARKER = '## Documentation Rules';

export const DOC_RULES = `
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

/** Fetch origin and create a task branch from origin/{branch}. Fix local origin URLs. */
export async function checkoutTaskBranch(git: GitClient, ctx: AgentContext): Promise<void> {
  await git.fetch(ctx.clonePath);
  const localBranch = `${ctx.agentId}-${ctx.taskId}`;
  await git.createBranch(ctx.clonePath, localBranch, `origin/${ctx.branch}`);

  // Fix origin remote if it's a local path
  const originUrl = await git.getRemoteUrl(ctx.clonePath);
  if (originUrl && originUrl.startsWith('/')) {
    const sourceRemote = await git.getRemoteUrl(originUrl);
    if (sourceRemote) {
      await git.setRemoteUrl(ctx.clonePath, sourceRemote);
    }
  }
}

/** Create agent-docs and shared-docs symlinks in the clone. */
export function setupDocs(ctx: AgentContext): void {
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

/** Append entries to .gitignore if not already present. */
export function updateGitignore(ctx: AgentContext, entries: string[]): void {
  const gitignorePath = join(ctx.clonePath, '.gitignore');

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

/** Create log directory, rotate old logs, return logDir and logPath. */
export function setupOutputCapture(
  agentId: string,
  dataDir: string,
  taskId: string,
  maxLogs = 20,
): { logDir: string; logPath: string } {
  const logDir = join(dataDir, 'logs', agentId);
  mkdirSync(logDir, { recursive: true });
  rotateLogFiles(logDir, maxLogs);
  const logPath = join(logDir, `${taskId}.log`);
  return { logDir, logPath };
}

/** Keep only the most recent maxLogs files per agent log directory. */
export function rotateLogFiles(logDir: string, maxLogs: number): void {
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

/** Build `script` command args for output capture (platform-aware). */
export function buildScriptArgs(agentArgs: string[], logPath: string): string[] {
  if (process.platform === 'darwin') {
    // macOS: script -q <file> <cmd...>
    return ['script', '-q', logPath, ...agentArgs];
  } else {
    // Linux: script -qc "<cmd...>" <file>
    const cmdStr = agentArgs.map(a => a.includes(' ') ? `"${a}"` : a).join(' ');
    return ['script', '-qc', cmdStr, logPath];
  }
}

/** Build prompt with optional tracking and workflow context prefixes. */
export function buildPromptWithContext(ctx: AgentContext): string {
  let prompt = '';
  if (ctx.trackingContext) prompt += ctx.trackingContext + '\n';
  if (ctx.workflowContext) prompt += ctx.workflowContext + '\n';
  prompt += ctx.prompt;
  return prompt;
}
