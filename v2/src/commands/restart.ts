import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green } from '../util/colors.js';
import { buildRunnerCommand } from '../util/runner-command.js';

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Try to restart an agent in its existing pane by sending Ctrl-C + new command.
 * Handles both surface: refs (from start) and workspace: refs (from launch).
 */
async function restartInExistingPane(ctx: AppContext, workspaceId: string, cmd: string): Promise<boolean> {
  try {
    if (workspaceId.startsWith('surface:')) {
      const surfaceRef = workspaceId.slice('surface:'.length);
      // Kill existing process
      await ctx.cmux.sendKeys(surfaceRef, '\x03');
      await sleep(300);
      await ctx.cmux.sendKeys(surfaceRef, '\x03');
      await sleep(500);
      // Send new runner command
      await ctx.cmux.send({ surface: surfaceRef }, cmd);
      return true;
    }

    if (workspaceId.startsWith('workspace:')) {
      const panes = await ctx.cmux.listPanes(workspaceId);
      if (panes.length > 0) {
        const paneId = panes[0].id;
        await ctx.cmux.sendKeys(paneId, '\x03');
        await sleep(300);
        await ctx.cmux.sendKeys(paneId, '\x03');
        await sleep(500);
        await ctx.cmux.send({ surface: paneId }, cmd);
        return true;
      }
    }
  } catch {
    // Pane/workspace may no longer exist
  }
  return false;
}

export function registerRestartCommand(program: Command, ctx: AppContext): void {
  program
    .command('restart')
    .description('Refresh and relaunch agent')
    .argument('[index]', 'Clone index')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--no-queue', 'Run without task queue')
    .option('--agent <type>', 'Agent type (claude or codex)')
    .action(async (indexStr: string | undefined, opts: {
      env?: string;
      skipPermissions?: boolean;
      queue?: boolean;
      agent?: string;
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
        // Release any stuck in_progress tasks for this agent
        const agentId = `agent-${String(clone.cloneIndex).padStart(2, '0')}`;
        const released = ctx.stores.tasks.releaseAgent(project.name, agentId);
        if (released > 0) {
          console.log(`Released ${released} stuck task(s) for ${agentId}`);
        }

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
        const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, opts);

        // Try to restart in existing pane/surface
        if (clone.workspaceId) {
          const restarted = await restartInExistingPane(ctx, clone.workspaceId, cmd);
          if (restarted) {
            poolService.lock(project.name, clone.cloneIndex, clone.workspaceId);
            console.log(green(`Restarted clone ${clone.cloneIndex} in existing pane`));
            continue;
          }
        }

        // Fallback: launch as a new split in the current workspace
        const { surfaceRef } = await ctx.cmux.newSplit('right', {});
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, clone.cloneIndex, `surface:${surfaceRef}`);
        console.log(green(`Restarted clone ${clone.cloneIndex} in new split`));
      }
    });
}
