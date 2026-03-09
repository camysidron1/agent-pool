import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import type { TaskStatus } from '../stores/interfaces.js';
import { TaskService } from '../services/task-service.js';

const VALID_STATUSES: TaskStatus[] = ['pending', 'in_progress', 'completed', 'blocked', 'backlogged', 'cancelled'];

export function registerSetStatusCommand(program: Command, ctx: AppContext): void {
  program
    .command('set-status')
    .description('Set task status directly')
    .argument('<task-id>', 'Task ID')
    .argument('<status>', 'New status')
    .action((taskId: string, status: string) => {
      if (!VALID_STATUSES.includes(status as TaskStatus)) {
        console.error(`Error: invalid status '${status}'. Must be one of: ${VALID_STATUSES.join(', ')}`);
        process.exit(1);
      }

      const taskService = new TaskService(ctx.stores.tasks);
      try {
        taskService.setStatus(taskId, status as TaskStatus);
        console.log(`Set task ${taskId} to ${status}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
