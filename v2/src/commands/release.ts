import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green } from '../util/colors.js';

export function registerReleaseCommand(program: Command, ctx: AppContext): void {
  program
    .command('release')
    .description('Release (unlock) a clone')
    .argument('<index>', 'Clone index')
    .action((indexStr: string) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const index = parseInt(indexStr, 10);
      if (isNaN(index)) {
        console.error('Error: index must be a number');
        process.exit(1);
      }

      const clone = ctx.stores.clones.get(project.name, index);
      if (!clone) {
        console.error(`Error: clone ${index} not found for project '${project.name}'`);
        process.exit(1);
      }

      poolService.unlock(project.name, index);
      console.log(green(`Released clone ${index}`));
    });
}
