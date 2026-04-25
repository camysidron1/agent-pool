import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green, bold, red } from '../util/colors.js';
import { buildRunnerCommand } from '../util/runner-command.js';
import { ensureDaemonRunning } from '../util/ensure-daemon.js';
import { killRunnerByHeartbeat, sleep } from '../util/kill-runner.js';

export function registerScaleCommand(program: Command, ctx: AppContext): void {
  const scale = program
    .command('scale')
    .description('Scale agent pool up or down');

  scale
    .command('up')
    .description('Add agents to the current workspace')
    .argument('[count]', 'Number of agents to add', '1')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--agent <type>', 'Agent type (claude, codex, or pi)')
    .action(async (countStr: string, opts: {
      skipPermissions?: boolean;
      agent?: string;
    }) => {
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1) {
        console.error('Error: count must be a positive number');
        process.exit(1);
      }

      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);
      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const workspaceRef = process.env.CMUX_WORKSPACE_ID || undefined;

      await ensureDaemonRunning(ctx.config.dataDir, ctx.config.toolDir);

      console.log(bold(`Adding ${count} agent(s) to '${project.name}'...`));

      for (let i = 0; i < count; i++) {
        // Create or reuse a clone
        let clone = poolService.findFree(project.name);
        if (!clone) {
          try {
            clone = await poolService.createClone(
              project.name,
              project.source,
              project.branch,
              project.prefix,
              ctx.config.dataDir,
              project.setup,
            );
          } catch (e: any) {
            console.error(`  Failed to create clone: ${e.message}`);
            break;
          }
        }

        const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, {
          skipPermissions: opts.skipPermissions,
          agent: opts.agent,
          workspaceRef,
        });

        // Add a new split pane in the current workspace
        const { surfaceRef } = await ctx.cmux.newSplit('right', {});
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, clone.cloneIndex, `surface:${surfaceRef}`, workspaceRef);

        console.log(green(`  Added agent-${String(clone.cloneIndex).padStart(2, '0')}`));
      }
    });

  scale
    .command('down')
    .description('Remove agents from the current workspace')
    .argument('[count]', 'Number of agents to remove', '1')
    .action(async (countStr: string) => {
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1) {
        console.error('Error: count must be a positive number');
        process.exit(1);
      }

      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);
      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const workspaceRef = process.env.CMUX_WORKSPACE_ID || undefined;
      const lockedClones = workspaceRef
        ? poolService.listByWorkspace(project.name, workspaceRef).filter(c => c.locked)
        : poolService.list(project.name).filter(c => c.locked);

      if (lockedClones.length === 0) {
        console.log('No running agents to remove.');
        return;
      }

      // Remove from the highest index first (most recently added)
      const targets = lockedClones
        .sort((a, b) => b.cloneIndex - a.cloneIndex)
        .slice(0, count);

      console.log(bold(`Removing ${targets.length} agent(s) from '${project.name}'...`));

      for (const clone of targets) {
        const agentId = `agent-${String(clone.cloneIndex).padStart(2, '0')}`;

        // Kill the runner process
        await killRunnerByHeartbeat(ctx.config.dataDir, agentId);

        // Close the pane
        if (clone.workspaceId.startsWith('surface:')) {
          const surfaceRef = clone.workspaceId.slice('surface:'.length);
          try {
            await ctx.cmux.sendKeys(surfaceRef, '\x03');
            await sleep(300);
            await ctx.cmux.closeSurface(surfaceRef);
          } catch {
            // Surface may already be gone
          }
        }

        // Release the clone and any stuck tasks
        poolService.unlock(project.name, clone.cloneIndex);
        const released = ctx.stores.tasks.releaseAgent(project.name, agentId);
        if (released > 0) {
          console.log(`  Released ${released} task(s) for ${agentId}`);
        }
        console.log(red(`  Removed ${agentId}`));
      }
    });
}
