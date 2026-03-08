import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { PoolService } from '../services/pool-service.js';
import { bold, red, green } from '../util/colors.js';

export function registerStatusCommand(program: Command, ctx: AppContext): void {
  program
    .command('status')
    .description('Show project status overview')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      console.log(bold(`Project: ${project.name}`));
      console.log(`  Source: ${project.source}`);
      console.log(`  Branch: ${project.branch}`);

      // Task counts
      const tasks = taskService.list(project.name);
      const counts: Record<string, number> = {};
      for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
      }

      console.log(`\nTasks: ${tasks.length} total`);
      for (const [status, count] of Object.entries(counts)) {
        console.log(`  ${status}: ${count}`);
      }

      // Clone counts
      const clones = poolService.list(project.name);
      const locked = clones.filter(c => c.locked).length;
      const free = clones.length - locked;

      console.log(`\nClones: ${clones.length} total, ${locked} locked, ${free} free`);

      if (clones.length === 0) {
        console.log('(no clones — run agent-pool init)');
      } else {
        console.log('');
        console.log('Clone    Status       Branch               Workspace');
        console.log('-----    ------       ------               ---------');
        for (const clone of clones) {
          const idx = String(clone.cloneIndex).padStart(2, '0');
          const status = clone.locked ? red('LOCKED') : green('free');
          const statusPad = clone.locked ? '       ' : '         ';
          const branch = clone.branch;
          const workspace = clone.workspaceId || '-';
          console.log(`${idx}       ${status}${statusPad}${branch.padEnd(21)}${workspace}`);
        }
      }
    });
}
