import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green } from '../util/colors.js';

export function registerRefreshCommand(program: Command, ctx: AppContext): void {
  program
    .command('refresh')
    .description('Refresh clone(s)')
    .argument('[index]', 'Clone index (omit for --all)')
    .option('--all', 'Refresh all clones')
    .action(async (indexStr: string | undefined, opts: { all?: boolean }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      if (opts.all) {
        const clones = poolService.list(project.name);
        if (clones.length === 0) {
          console.log('No clones to refresh.');
          return;
        }
        for (const clone of clones) {
          await poolService.refreshClone(
            project.name,
            clone.cloneIndex,
            project.branch,
            ctx.config.dataDir,
            project.prefix,
          );
          console.log(green(`  Refreshed clone ${clone.cloneIndex}`));
        }
        console.log(`Refreshed ${clones.length} clones.`);
        return;
      }

      if (indexStr === undefined) {
        console.error('Error: specify a clone index or use --all');
        process.exit(1);
      }

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

      await poolService.refreshClone(
        project.name,
        index,
        project.branch,
        ctx.config.dataDir,
        project.prefix,
      );
      console.log(green(`Refreshed clone ${index}`));
    });
}
