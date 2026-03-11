import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { bold } from '../util/colors.js';

export function registerHelpCommand(program: Command, _ctx: AppContext): void {
  program
    .command('help')
    .description('Show help')
    .action(() => {
      console.log(bold('agent-pool') + ' v2.0.0\n');
      console.log('Usage: agent-pool [options] <command>\n');
      console.log('Options:');
      console.log('  -p, --project <name>    Project name\n');
      console.log('Commands:');
      console.log('  add [options] <prompt>   Add a task');
      console.log('  tasks                    List tasks');
      console.log('  unblock <task-id>        Unblock a blocked task');
      console.log('  backlog <task-id>        Move task to backlog');
      console.log('  activate <task-id>       Activate a backlogged task');
      console.log('  set-status <id> <status> Set task status directly');
      console.log('  status                   Show project status overview');
      console.log('  project <subcommand>     Manage projects');
      console.log('  migrate                  Migrate from v1 data');
      console.log('  docs                     Open documentation');
      console.log('  init                     Initialize clone pool');
      console.log('  launch                   Launch agents');
      console.log('  start                    Interactive guided setup');
      console.log('  refresh [index]          Refresh clone(s)');
      console.log('  release [index]          Release clone(s)');
      console.log('  destroy [index]          Destroy clone(s)');
      console.log('  restart [index]          Restart agent(s)');
      console.log('  logs [task-id]            View task execution logs');
      console.log('  review [options]          Dispatch a review agent');
      console.log('  daemon <subcommand>      Manage the daemon');
      console.log('  integration <subcommand> Manage integrations');
      console.log('  approvals                Manage approvals');
      console.log('  help                     Show this help');
    });
}
