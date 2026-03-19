import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { green, yellow, dim } from '../util/colors.js';

export function registerNextCommand(program: Command, ctx: AppContext): void {
  program
    .command('next')
    .description('Show the task that would be claimed next')
    .option('--top <n>', 'Show top N tasks in claim order', parseInt)
    .action((opts: { top?: number }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);
      const n = opts.top ?? 1;

      const eligible = ctx.stores.tasks.nextEligible(project.name, n);

      if (eligible.length === 0) {
        console.log('No eligible tasks. Queue is empty or all tasks are blocked/waiting on dependencies.');
        return;
      }

      const label = n === 1 ? 'Next task' : `Top ${eligible.length} tasks (claim order)`;
      console.log(green(label));
      console.log();

      for (let i = 0; i < eligible.length; i++) {
        const task = eligible[i];
        const deps = taskService.getDependencies(task.id);
        const prioLabel = task.priority ? yellow(` [P${task.priority}]`) : '';
        const depLabel = deps.length > 0 ? dim(` [deps: ${deps.join(',')}]`) : '';
        const rank = n > 1 ? dim(`${i + 1}. `) : '';

        console.log(`${rank}${task.id}${prioLabel}${depLabel}`);
        console.log(`   ${task.prompt.length > 120 ? task.prompt.slice(0, 117) + '...' : task.prompt}`);
        if (i < eligible.length - 1) console.log();
      }
    });
}
