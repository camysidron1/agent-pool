import { existsSync } from 'fs';
import { readFileSync } from 'fs';
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
    .option('--cat', 'Dump full log file to stdout')
    .option('--tail <n>', 'Show last N lines (default 50)', parseInt)
    .option('-f, --follow', 'Stream new content as it is written')
    .action(async (taskId: string | undefined, opts: { agent?: string; last?: number; cat?: boolean; tail?: number; follow?: boolean }) => {
      const taskService = new TaskService(ctx.stores.tasks);

      // Content viewing flags require a task-id
      const wantsContent = opts.cat || opts.tail !== undefined || opts.follow;
      if (wantsContent && !taskId) {
        console.error('A task-id is required when using --cat, --tail, or --follow.');
        return;
      }

      if (wantsContent && taskId) {
        const logs = taskService.getLogs({ taskId, limit: 1 });
        if (logs.length === 0) {
          console.log('No logs found.');
          return;
        }
        const logPath = logs[0].logPath;

        if (!existsSync(logPath)) {
          console.error(`Log file not found: ${logPath}`);
          return;
        }

        if (opts.follow) {
          await followLog(logPath, taskId, ctx);
          return;
        }

        const content = readFileSync(logPath, 'utf-8');

        if (opts.cat) {
          process.stdout.write(content);
          return;
        }

        // --tail
        const n = opts.tail ?? 50;
        const lines = content.split('\n');
        const tail = lines.slice(-n).join('\n');
        process.stdout.write(tail);
        return;
      }

      // Default metadata listing
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

async function followLog(logPath: string, taskId: string, ctx: AppContext): Promise<void> {
  let offset = 0;

  const flush = () => {
    const content = readFileSync(logPath, 'utf-8');
    if (content.length > offset) {
      process.stdout.write(content.slice(offset));
      offset = content.length;
    }
  };

  // Output existing content
  flush();

  // Poll for new content until task completes or interrupted
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      flush();
      const task = ctx.stores.tasks.get(taskId);
      if (!task || task.status !== 'in_progress') {
        flush(); // Final flush
        clearInterval(interval);
        resolve();
      }
    }, 500);

    // Allow Ctrl+C to stop
    process.on('SIGINT', () => {
      clearInterval(interval);
      resolve();
    });
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
