import type { QueueSummary } from '../services/task-service.js';
import { bold, dim, green, yellow, red, cyan } from './colors.js';

export function formatQueueSummary(summary: QueueSummary): string {
  const lines: string[] = [];

  lines.push(bold('Queue:'));

  // Counts line
  const parts: string[] = [];
  if (summary.inProgress > 0) parts.push(cyan(`${summary.inProgress} running`));
  if (summary.claimable > 0) parts.push(green(`${summary.claimable} claimable`));
  if (summary.waitingOnDeps > 0) parts.push(yellow(`${summary.waitingOnDeps} waiting on deps`));
  if (summary.blocked > 0) parts.push(red(`${summary.blocked} blocked`));
  if (summary.backlogged > 0) parts.push(dim(`${summary.backlogged} backlogged`));

  if (parts.length > 0) {
    lines.push(`  ${parts.join('  ')}`);
  }

  // Next claimable
  if (summary.nextClaimable) {
    const t = summary.nextClaimable;
    const prompt = t.prompt.length > 50 ? t.prompt.slice(0, 47) + '...' : t.prompt;
    const prio = t.priority ? yellow(` [P${t.priority}]`) : '';
    lines.push(`  Next: ${green(t.id)}${prio}  ${prompt}`);
  } else if (summary.claimable === 0 && summary.blocked > 0) {
    lines.push(`  ${red('No claimable tasks — unblock stuck tasks to resume')}`);
  } else if (summary.claimable === 0 && summary.waitingOnDeps > 0) {
    lines.push(`  ${yellow('No claimable tasks — all pending are waiting on deps')}`);
  } else if (summary.pending === 0 && summary.inProgress === 0) {
    lines.push(`  ${dim('All tasks completed or idle — add more work')}`);
  }

  return lines.join('\n');
}
