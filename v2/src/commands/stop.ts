import type { Command } from 'commander';
import { join } from 'path';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { teardownProject } from '../services/teardown.js';
import { DaemonClient } from '../daemon/client.js';
import { bold, green } from '../util/colors.js';

export function registerStopCommand(program: Command, ctx: AppContext): void {
  program
    .command('stop')
    .description('Gracefully stop agents (current workspace only, or --all)')
    .option('--all', 'Stop agents in all workspaces')
    .option('--daemon', 'Also stop the daemon')
    .action(async (opts: { all?: boolean; daemon?: boolean }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const workspaceRef = opts.all ? undefined : (process.env.CMUX_WORKSPACE_ID || undefined);

      if (workspaceRef) {
        console.log(bold(`Stopping agents for '${project.name}' in current workspace...`));
      } else {
        console.log(bold(`Stopping all agents for '${project.name}'...`));
      }

      const result = await teardownProject(ctx, project.name, poolService, workspaceRef);

      if (result.agentsKilled > 0) {
        console.log(green(`Stopped ${result.agentsKilled} agent(s).`));
      }
      if (result.tasksReleased > 0) {
        console.log(green(`Released ${result.tasksReleased} in-progress task(s) back to pending.`));
      }
      if (result.agentsKilled === 0 && result.tasksReleased === 0) {
        console.log('No running agents found.');
      }

      if (opts.daemon) {
        const socketPath = join(ctx.config.dataDir, 'apd.sock');
        const client = new DaemonClient({ socketPath, timeoutMs: 3000 });
        if (await client.connect()) {
          try {
            await client.request('shutdown');
            console.log(green('Daemon stopped.'));
          } catch {
            // already stopping
          }
          client.close();
        } else {
          console.log('Daemon not running.');
        }
      }
    });
}
