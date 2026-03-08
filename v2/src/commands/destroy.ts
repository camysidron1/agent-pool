import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { rmSync } from 'fs';
import { bold, red } from '../util/colors.js';

export function registerDestroyCommand(program: Command, ctx: AppContext): void {
  program
    .command('destroy')
    .description('Destroy all clones for a project')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const clones = poolService.list(project.name);
      if (clones.length === 0) {
        console.log('No clones to destroy.');
        return;
      }

      console.log(bold(`Destroying ${clones.length} clones for '${project.name}'...`));

      for (const clone of clones) {
        const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
        try {
          rmSync(clonePath, { recursive: true, force: true });
        } catch {
          // Directory may not exist on disk — that's fine
        }
        poolService.removeClone(project.name, clone.cloneIndex);
        console.log(red(`  Removed clone ${clone.cloneIndex}`));
      }

      console.log(`Destroyed ${clones.length} clones.`);
    });
}
