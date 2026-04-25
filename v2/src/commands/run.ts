import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { join } from 'path';
import { existsSync } from 'fs';

export function registerRunCommand(program: Command, ctx: AppContext): void {
  program
    .command('run')
    .description('Run a task with an ephemeral agent (no pool dependency)')
    .option('-q, --quiet', 'Minimal output')
    .option('--priority <n>', 'Task priority for tracking', parseInt)
    .option('--env <name>', 'Environment name for nenv')
    .option('--clone <index>', 'Use specific clone index (default: finds or creates one)')
    .option('--no-track', 'Skip recording task in DB')
    .argument('<prompt>', 'Task prompt')
    .action(async (prompt: string, opts: {
      quiet?: boolean;
      priority?: number;
      env?: string;
      clone?: string;
      track?: boolean;
    }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);
      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      // 1. Record task in DB for dashboard visibility
      let taskId: string | null = null;
      if (opts.track !== false) {
        const task = taskService.add({
          projectName: project.name,
          prompt,
          status: 'pending',
          priority: opts.priority,
        });
        taskId = task.id;
        // Immediately claim it
        taskService.mark(task.id, 'in_progress');
        if (!opts.quiet) console.log(`Task ${task.id} (ephemeral)`);
        if (opts.quiet) console.log(task.id);
      }

      // 2. Find a working directory — use source repo directly (loops are read-only)
      const workDir = project.source;
      if (!workDir || !existsSync(workDir)) {
        console.error(`Project source not found: ${workDir}`);
        if (taskId) taskService.mark(taskId, 'blocked');
        process.exit(1);
      }

      // 3. Build claude command
      const claudeArgs = ['-p', prompt, '--output-format', 'text'];
      const cmd = opts.env ? ['nenv', 'claude', ...claudeArgs] : ['claude', ...claudeArgs];
      const env = { ...process.env };
      if (opts.env) env.ENV = opts.env;

      if (!opts.quiet) console.log(`Running in ${workDir}...`);

      // 4. Spawn ephemeral claude session
      const startedAt = new Date().toISOString();
      const proc = Bun.spawn(cmd, {
        cwd: workDir,
        stdin: 'ignore',
        stdout: opts.quiet ? 'pipe' : 'inherit',
        stderr: opts.quiet ? 'pipe' : 'inherit',
        env,
      });

      const exitCode = await proc.exited;
      const completedAt = new Date().toISOString();

      // 5. Mark task based on exit code
      if (taskId) {
        const status = exitCode === 0 ? 'completed' : 'blocked';
        taskService.mark(taskId, status);
        if (!opts.quiet) {
          const duration = Math.floor((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000);
          console.log(`Task ${taskId} ${status} (${duration}s)`);
        }
      }

      process.exit(exitCode);
    });
}
