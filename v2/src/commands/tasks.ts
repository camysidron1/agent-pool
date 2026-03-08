import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { statusColor, dim, yellow } from '../util/colors.js';

export function registerTasksCommand(program: Command, ctx: AppContext): void {
  program
    .command('tasks')
    .description('List tasks')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);
      const tasks = taskService.list(project.name);

      if (tasks.length === 0) {
        console.log('No tasks.');
        return;
      }

      // Build display rows
      for (const task of tasks) {
        const deps = taskService.getDependencies(task.id);
        const colorFn = statusColor(task.status);

        // Determine display status
        let displayStatus = task.status;
        if (task.status === 'pending' && deps.length > 0) {
          // Check if all deps are completed
          const unmetCount = deps.filter(depId => {
            const depTask = taskService.get(depId);
            return depTask && depTask.status !== 'completed';
          }).length;
          if (unmetCount > 0) {
            displayStatus = `waiting (${unmetCount})`;
          }
        }

        const truncatedPrompt = task.prompt.length > 60
          ? task.prompt.slice(0, 57) + '...'
          : task.prompt;

        const claimedBy = task.claimedBy || '-';
        const depSuffix = deps.length > 0 ? dim(` [deps: ${deps.join(',')}]`) : '';
        const prioSuffix = task.priority ? yellow(` [P${task.priority}]`) : '';
        const retrySuffix = task.status === 'in_progress' && task.retryMax > 1
          ? dim(` [attempt ${task.retryCount + 1}/${task.retryMax}]`)
          : '';

        console.log(
          `${task.id}  ${colorFn(displayStatus.padEnd(16))}  ${claimedBy.padEnd(12)}  ${truncatedPrompt}${prioSuffix}${retrySuffix}${depSuffix}`
        );
      }
    });
}
