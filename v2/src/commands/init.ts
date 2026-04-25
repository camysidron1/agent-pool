import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { bold, green } from '../util/colors.js';

export function registerInitCommand(program: Command, ctx: AppContext): void {
  program
    .command('init')
    .description('Initialize clone pool')
    .option('-n, --count <count>', 'Number of clones', '4')
    .option('--launch', 'Launch agents after init')
    .option('--here', 'Launch in current terminal')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--no-queue', 'Run without task queue')
    .option('--no-push', 'Disable daemon push mode (use polling)')
    .option('--no-driver', 'Skip driver pane')
    .action(async (opts: {
      count: string;
      launch?: boolean;
      here?: boolean;
      env?: string;
      skipPermissions?: boolean;
      queue?: boolean;
      push?: boolean;
      driver?: boolean;
    }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);
      const count = parseInt(opts.count, 10);

      if (isNaN(count) || count < 1) {
        console.error('Error: count must be a positive integer');
        process.exit(1);
      }

      const existing = poolService.list(project.name);
      if (existing.length > 0) {
        console.log(`Project '${project.name}' already has ${existing.length} clones. Use 'destroy' first to reset.`);
        process.exit(1);
      }

      console.log(bold(`Initializing ${count} clones for project '${project.name}'...`));

      for (let i = 0; i < count; i++) {
        const clone = await poolService.createClone(
          project.name,
          project.source,
          project.branch,
          project.prefix,
          ctx.config.dataDir,
          project.setup,
        );
        console.log(green(`  Clone ${clone.cloneIndex} created`));
      }

      console.log(`\n${count} clones ready.`);

      if (opts.launch) {
        // Delegate to launch logic
        const { launchAgents } = await import('./launch.js');
        await launchAgents(ctx, program, {
          grid: !opts.here,
          here: opts.here,
          env: opts.env,
          skipPermissions: opts.skipPermissions,
          queue: opts.queue,
          push: opts.push,
          driver: opts.driver,
        });
      }
    });
}
