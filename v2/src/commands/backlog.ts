import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { TaskService } from '../services/task-service.js';

export function registerBacklogCommand(program: Command, ctx: AppContext): void {
  program
    .command('backlog')
    .description('Move a task to backlog')
    .argument('<task-id>', 'Task ID')
    .action((taskId: string) => {
      const taskService = new TaskService(ctx.stores.tasks);
      try {
        taskService.backlog(taskId);
        console.log(`Backlogged task ${taskId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
