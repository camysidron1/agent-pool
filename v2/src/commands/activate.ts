import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { TaskService } from '../services/task-service.js';

export function registerActivateCommand(program: Command, ctx: AppContext): void {
  program
    .command('activate')
    .description('Activate a backlogged task')
    .argument('<task-id>', 'Task ID')
    .action((taskId: string) => {
      const taskService = new TaskService(ctx.stores.tasks);
      try {
        taskService.activate(taskId);
        console.log(`Activated task ${taskId}`);
      } catch (err: any) {
        console.error(`Error: ${err.message}`);
        process.exit(1);
      }
    });
}
