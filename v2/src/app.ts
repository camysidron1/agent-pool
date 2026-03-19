import { Command } from 'commander';
import type { AppContext } from './container.js';
import { registerAddCommand } from './commands/add.js';
import { registerTasksCommand } from './commands/tasks.js';
import { registerStatusCommand } from './commands/status.js';
import { registerProjectCommand } from './commands/project.js';
import { registerUnblockCommand } from './commands/unblock.js';
import { registerBacklogCommand } from './commands/backlog.js';
import { registerActivateCommand } from './commands/activate.js';
import { registerSetStatusCommand } from './commands/set-status.js';
import { registerMigrateCommand } from './commands/migrate.js';
import { registerHelpCommand } from './commands/help.js';
import { registerDocsCommand } from './commands/docs.js';
import { registerInitCommand } from './commands/init.js';
import { registerLaunchCommand } from './commands/launch.js';
import { registerStartCommand } from './commands/start.js';
import { registerRefreshCommand } from './commands/refresh.js';
import { registerReleaseCommand } from './commands/release.js';
import { registerDestroyCommand } from './commands/destroy.js';
import { registerRestartCommand } from './commands/restart.js';
import { registerApprovalsCommands } from './commands/approvals.js';
import { registerReviewCommand } from './commands/review.js';
import { registerLogsCommand } from './commands/logs.js';
import { registerDaemonCommand } from './commands/daemon.js';
import { registerIntegrationCommand } from './commands/integration.js';
import { registerNextCommand } from './commands/next.js';
import { registerRunAgentCommand } from './commands/run-agent.js';

export function createApp(ctx: AppContext): Command {
  const program = new Command();
  program.name('agent-pool').version('2.0.0');

  // Global -p option
  program.option('-p, --project <name>', 'project name');

  // Core task commands
  registerAddCommand(program, ctx);
  registerTasksCommand(program, ctx);
  registerUnblockCommand(program, ctx);
  registerBacklogCommand(program, ctx);
  registerActivateCommand(program, ctx);
  registerSetStatusCommand(program, ctx);
  registerNextCommand(program, ctx);

  // Project commands
  registerProjectCommand(program, ctx);

  // Status and info
  registerStatusCommand(program, ctx);
  registerDocsCommand(program, ctx);
  registerHelpCommand(program, ctx);
  registerMigrateCommand(program, ctx);

  // WP5 stubs
  registerInitCommand(program, ctx);
  registerLaunchCommand(program, ctx);
  registerStartCommand(program, ctx);
  registerRefreshCommand(program, ctx);
  registerReleaseCommand(program, ctx);
  registerDestroyCommand(program, ctx);
  registerRestartCommand(program, ctx);

  // Review
  registerReviewCommand(program, ctx);

  // Logs
  registerLogsCommand(program, ctx);

  // Daemon
  registerDaemonCommand(program, ctx);

  // Integrations
  registerIntegrationCommand(program, ctx);

  // Run agent
  registerRunAgentCommand(program, ctx);

  // Approvals
  registerApprovalsCommands(program, ctx);

  return program;
}
