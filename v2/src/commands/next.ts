import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';

export function registerNextCommand(program: Command, ctx: AppContext): void {
  program
    .command('next')
    .description('Show the next claimable task (read-only preview)')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const task = taskService.next(project.name);

      if (task) {
        const depIds = taskService.getDependencies(task.id);
        const depInfo = depIds.length ? ` [deps: ${depIds.join(',')}]` : '';
        const prioInfo = task.priority ? ` [priority: ${task.priority}]` : '';
        console.log(`${task.id} (${task.status})${prioInfo}${depInfo} ${task.prompt}`);
        return;
      }

      // No claimable task — check if there are pending tasks blocked by deps
      const allTasks = taskService.list(project.name);
      const pendingCount = allTasks.filter(t => t.status === 'pending').length;

      if (pendingCount > 0) {
        console.log(`No claimable task — ${pendingCount} pending task(s) waiting on dependencies`);
      } else {
        console.log('No claimable tasks');
      }
    });
}
