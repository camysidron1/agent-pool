import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';

function buildBranchesPrompt(timestamp: string): string {
  return `You are a code review agent. Review open agent branches for quality and coherence.

## Steps

1. List branches matching the \`agent-*\` pattern:
   git branch -r --list 'origin/agent-*' | head -30

2. For each active branch, review its diff against the base branch:
   git log main..BRANCH --oneline
   git diff main...BRANCH --stat
   git diff main...BRANCH

3. Look for:
   - Code duplication across branches
   - Conflicting changes between branches
   - Regressions or broken patterns
   - Inconsistent style or conventions
   - Incomplete or dead code

4. Write your report to agent-docs/review-${timestamp}.md with:
   - **Overall Assessment**: Summary of branch quality
   - **Branch-by-Branch**: Key findings per branch
   - **Concerning Patterns**: Code duplication, regressions, inconsistencies
   - **Suggestions**: Follow-up work or fixes needed
   - **Quality Score**: 1-5 with justification
     (1=critical issues, 2=significant concerns, 3=acceptable, 4=good, 5=excellent)

5. Finish with: /finish done "Review complete: agent-docs/review-${timestamp}.md"`;
}

function buildCommitsPrompt(commits: number, timestamp: string): string {
  return `You are a code review agent. Review the ${commits} most recent commits for quality and coherence.

## Steps

1. Get recent commit history:
   git log --oneline -${commits}

2. For each commit, examine the changes:
   git show <sha> --stat
   git show <sha>

3. Analyze the changes looking for:
   - Code quality issues (duplication, complexity, poor naming)
   - Potential regressions or bugs introduced
   - Inconsistencies between commits (conflicting approaches)
   - Missing tests for significant changes
   - Style or convention violations

4. Write your report to agent-docs/review-${timestamp}.md with:
   - **Overall Assessment**: Summary of recent change quality
   - **Commit-by-Commit**: Notable findings per commit (skip trivial ones)
   - **Concerning Patterns**: Code duplication, regressions, inconsistencies
   - **Suggestions**: Follow-up work or fixes needed
   - **Quality Score**: 1-5 with justification
     (1=critical issues, 2=significant concerns, 3=acceptable, 4=good, 5=excellent)

5. Finish with: /finish done "Review complete: agent-docs/review-${timestamp}.md"`;
}

export function registerReviewCommand(program: Command, ctx: AppContext): void {
  program
    .command('review')
    .description('Dispatch a review agent to assess recent work quality')
    .option('--commits <n>', 'Number of recent commits to review', '20')
    .option('--branches', 'Review open agent branches instead of recent commits')
    .option('--auto', 'Flag for cron-based automation (marks task as auto-review)')
    .action((opts: { commits: string; branches?: boolean; auto?: boolean }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const now = new Date();
      const timestamp = now.getFullYear().toString()
        + String(now.getMonth() + 1).padStart(2, '0')
        + String(now.getDate()).padStart(2, '0')
        + '-'
        + String(now.getHours()).padStart(2, '0')
        + String(now.getMinutes()).padStart(2, '0')
        + String(now.getSeconds()).padStart(2, '0');

      const prompt = opts.branches
        ? buildBranchesPrompt(timestamp)
        : buildCommitsPrompt(parseInt(opts.commits, 10), timestamp);

      const task = taskService.add({
        projectName: project.name,
        prompt,
        status: 'pending',
      });

      console.log(`Added review task ${task.id} (pending)`);
    });
}
