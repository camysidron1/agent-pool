import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { AgentRunner } from '../runner/runner.js';
import { resolveAgentType, createAdapter } from '../adapters/factory.js';

export function registerRunAgentCommand(program: Command, ctx: AppContext): void {
  program
    .command('run-agent')
    .description('Run an agent on a clone (used by agent-runner.sh)')
    .argument('<index>', 'Clone index')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--agent <type>', 'Agent type (claude or codex)')
    .option('--push', 'use push mode (connect to daemon instead of polling)')
    .action(async (indexStr: string, opts: {
      env?: string;
      skipPermissions?: boolean;
      agent?: string;
      push?: boolean;
    }) => {
      const cloneIndex = parseInt(indexStr, 10);
      if (isNaN(cloneIndex)) {
        console.error('Error: index must be a number');
        process.exit(1);
      }

      const projectService = new ProjectService(ctx.stores.projects);
      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const agentType = resolveAgentType(opts.agent, project.agentType);
      const adapter = createAdapter(agentType, ctx.git);

      const runner = new AgentRunner(ctx, adapter, {
        cloneIndex,
        projectName: project.name,
        envName: opts.env,
        skipPermissions: !!opts.skipPermissions,
        nonInteractive: true,
        mode: opts.push ? 'push' : 'poll',
      });

      await runner.start();
    });
}
