import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { TaskService } from '../services/task-service.js';
import { dim, bold } from '../util/colors.js';

export function registerLogsCommand(program: Command, ctx: AppContext): void {
  program
    .command('logs')
    .description('View task execution logs')
    .argument('[task-id]', 'Task ID to view logs for')
    .option('--agent <id>', 'Filter by agent ID')
    .option('--last <n>', 'Show last N logs', parseInt)
    .action((taskId: string | undefined, opts: { agent?: string; last?: number }) => {
      const taskService = new TaskService(ctx.stores.tasks);

      const filter: { taskId?: string; agentId?: string; limit?: number } = {};
      if (taskId) filter.taskId = taskId;
      if (opts.agent) filter.agentId = opts.agent;
      if (opts.last) filter.limit = opts.last;

      // Default to last 20 if no filters
      if (!taskId && !opts.agent && !opts.last) {
        filter.limit = 20;
      }

      const logs = taskService.getLogs(filter);

      if (logs.length === 0) {
        console.log('No logs found.');
        return;
      }

      for (const log of logs) {
        const exit = log.exitCode !== null ? `exit=${log.exitCode}` : 'running';
        const duration = log.completedAt
          ? formatDuration(new Date(log.startedAt), new Date(log.completedAt))
          : 'in progress';

        console.log(
          `${bold(log.taskId)}  ${log.agentId}  ${exit}  ${duration}  ${dim(log.logPath)}`
        );
      }
    });
}

function formatDuration(start: Date, end: Date): string {
  const ms = end.getTime() - start.getTime();
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return `${minutes}m${remainingSeconds}s`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return `${hours}h${remainingMinutes}m`;
}
