import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green } from '../util/colors.js';

export function registerRestartCommand(program: Command, ctx: AppContext): void {
  program
    .command('restart')
    .description('Refresh and relaunch agent')
    .argument('[index]', 'Clone index')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--no-queue', 'Run without task queue')
    .action(async (indexStr: string | undefined, opts: {
      env?: string;
      skipPermissions?: boolean;
      queue?: boolean;
    }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const clones = poolService.list(project.name);
      if (clones.length === 0) {
        console.error('No clones found. Run init first.');
        process.exit(1);
      }

      let targetClones = clones;
      if (indexStr !== undefined) {
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
        targetClones = [clone];
      }

      for (const clone of targetClones) {
        // Refresh
        await poolService.refreshClone(
          project.name,
          clone.cloneIndex,
          project.branch,
          ctx.config.dataDir,
          project.prefix,
        );

        // Build runner command
        const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
        let cmd: string;
        if (opts.queue === false) {
          const flags = opts.skipPermissions ? ' --dangerously-skip-permissions' : '';
          cmd = `cd ${clonePath} && claude${flags}`;
        } else {
          const envFlag = opts.env ? ` --env ${opts.env}` : '';
          const skipFlag = opts.skipPermissions ? ' --skip-permissions' : '';
          cmd = `cd ${clonePath} && ${ctx.config.toolDir}/agent-runner.sh ${clone.cloneIndex} --project ${project.name}${envFlag}${skipFlag}`;
        }

        // If clone had a workspace, try to send to its pane
        if (clone.workspaceId && clone.workspaceId.startsWith('workspace:')) {
          try {
            const panes = await ctx.cmux.listPanes(clone.workspaceId);
            if (panes.length > 0) {
              await ctx.cmux.sendKeys(panes[0].id, cmd);
              poolService.lock(project.name, clone.cloneIndex, clone.workspaceId);
              console.log(green(`Restarted clone ${clone.cloneIndex} in existing workspace`));
              continue;
            }
          } catch {
            // Workspace may not exist anymore
          }
        }

        // Otherwise launch in a new workspace
        const { workspaceRef } = await ctx.cmux.newWorkspace({ command: cmd });
        await ctx.cmux.renameWorkspace(workspaceRef, `${project.name}-${clone.cloneIndex}`);
        poolService.lock(project.name, clone.cloneIndex, workspaceRef);
        console.log(green(`Restarted clone ${clone.cloneIndex} in new workspace`));
      }
    });
}
