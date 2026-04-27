import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import type { RetryStrategy } from '../stores/interfaces.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { notifyDaemon } from '../util/notify-daemon.js';

export function registerAddCommand(program: Command, ctx: AppContext): void {
  program
    .command('add')
    .description('Add a task')
    .option('--backlog', 'Add as backlogged')
    .option('--depends-on <ids>', 'Comma-separated dependency task IDs')
    .option('--priority <n>', 'Task priority (higher = claimed first)', parseInt)
    .option('--timeout <minutes>', 'Timeout in minutes', parseInt)
    .option('--retry <n>', 'Max attempts (default 1 = no retry)', parseInt)
    .option('--retry-strategy <strategy>', 'Retry strategy: same, augmented, escalate')
    .option('-q, --quiet', 'Print only the task ID (for scripting)')
    .option('--branch <name>', 'Checkout existing branch instead of creating a new one (enables session resume via claude)')
    .argument('<prompt>', 'Task prompt')
    .action((prompt: string, opts: {
      backlog?: boolean;
      dependsOn?: string;
      priority?: number;
      timeout?: number;
      retry?: number;
      retryStrategy?: string;
      quiet?: boolean;
      branch?: string;
    }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const dependsOn = opts.dependsOn
        ? opts.dependsOn.split(',').map(s => s.trim()).filter(Boolean)
        : undefined;

      // Validate dependency IDs exist
      if (dependsOn) {
        for (const depId of dependsOn) {
          const depTask = taskService.get(depId);
          if (!depTask) {
            console.error(`Error: dependency task '${depId}' not found`);
            process.exit(1);
          }
        }
      }

      // Validate retry strategy
      const validStrategies: RetryStrategy[] = ['same', 'augmented', 'escalate'];
      if (opts.retryStrategy && !validStrategies.includes(opts.retryStrategy as RetryStrategy)) {
        console.error(`Error: invalid retry strategy '${opts.retryStrategy}'. Must be one of: ${validStrategies.join(', ')}`);
        process.exit(1);
      }

      // Detect workspace for isolation (from cmux env var — fast, no subprocess)
      const workspaceRef = process.env.CMUX_WORKSPACE_ID || undefined;

      const task = taskService.add({
        projectName: project.name,
        prompt,
        status: opts.backlog ? 'backlogged' : 'pending',
        dependsOn,
        priority: opts.priority,
        timeoutMinutes: opts.timeout,
        retryMax: opts.retry,
        retryStrategy: opts.retryStrategy as RetryStrategy | undefined,
        workspaceRef,
        branch: opts.branch,
      });

      if (opts.quiet) {
        console.log(task.id);
      } else {
        const depInfo = dependsOn?.length ? ` [deps: ${dependsOn.join(',')}]` : '';
        const prioInfo = task.priority ? ` [priority: ${task.priority}]` : '';
        const retryInfo = task.retryMax > 1 ? ` [retry: ${task.retryMax}x ${task.retryStrategy}]` : '';
        const timeoutInfo = task.timeoutMinutes ? ` [timeout: ${task.timeoutMinutes}m]` : '';
        const branchInfo = task.branch ? ` [branch: ${task.branch}]` : '';
        console.log(`Added task ${task.id} (${task.status})${prioInfo}${retryInfo}${timeoutInfo}${depInfo}${branchInfo}`);
      }

      // Notify daemon so it can nudge idle runners
      notifyDaemon(ctx.config.dataDir, workspaceRef);
    });
}
