import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { TaskService } from '../services/task-service.js';

export function registerUnblockCommand(program: Command, ctx: AppContext): void {
  program
    .command('unblock')
    .description('Unblock a blocked task')
    .argument('<task-id>', 'Task ID')
    .action((taskId: string) => {
      const taskService = new TaskService(ctx.stores.tasks);
      try {
        taskService.unblock(taskId);
        console.log(`Unblocked task ${taskId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
