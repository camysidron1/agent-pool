import { readdirSync, readFileSync } from 'fs';
import { join } from 'path';
import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { TaskService } from '../services/task-service.js';
import { PoolService } from '../services/pool-service.js';
import { bold, red, green, yellow, dim } from '../util/colors.js';
import type { HeartbeatData } from '../runner/watchdog.js';

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

function formatAge(ms: number): string {
  if (ms < 1000) return 'just now';
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export function registerStatusCommand(program: Command, ctx: AppContext): void {
  program
    .command('status')
    .description('Show project status overview')
    .action(() => {
      const projectService = new ProjectService(ctx.stores.projects);
      const taskService = new TaskService(ctx.stores.tasks);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      console.log(bold(`Project: ${project.name}`));
      console.log(`  Source: ${project.source}`);
      console.log(`  Branch: ${project.branch}`);

      // Task counts
      const tasks = taskService.list(project.name);
      const counts: Record<string, number> = {};
      for (const task of tasks) {
        counts[task.status] = (counts[task.status] || 0) + 1;
      }

      console.log(`\nTasks: ${tasks.length} total`);
      for (const [status, count] of Object.entries(counts)) {
        console.log(`  ${status}: ${count}`);
      }

      // Clone counts
      const clones = poolService.list(project.name);
      const locked = clones.filter(c => c.locked).length;
      const free = clones.length - locked;

      console.log(`\nClones: ${clones.length} total, ${locked} locked, ${free} free`);

      if (clones.length === 0) {
        console.log('(no clones — run agent-pool init)');
      } else {
        console.log('');
        console.log('Clone    Status       Branch               Workspace');
        console.log('-----    ------       ------               ---------');
        for (const clone of clones) {
          const idx = String(clone.cloneIndex).padStart(2, '0');
          const status = clone.locked ? red('LOCKED') : green('free');
          const statusPad = clone.locked ? '       ' : '         ';
          const branch = clone.branch;
          const workspace = clone.workspaceId || '-';
          console.log(`${idx}       ${status}${statusPad}${branch.padEnd(21)}${workspace}`);
        }
      }

      // Heartbeat status
      showHeartbeats(ctx.config.dataDir);
    });
}

function showHeartbeats(dataDir: string): void {
  const heartbeatDir = join(dataDir, 'heartbeats');
  let files: string[];
  try {
    files = readdirSync(heartbeatDir).filter(f => f.endsWith('.json'));
  } catch {
    return; // no heartbeat directory
  }

  if (files.length === 0) return;

  console.log('');
  console.log(bold('Agent Heartbeats:'));
  const now = Date.now();

  for (const file of files) {
    try {
      const raw = readFileSync(join(heartbeatDir, file), 'utf-8');
      const data: HeartbeatData = JSON.parse(raw);
      const agentId = file.replace(/\.json$/, '');
      const age = now - new Date(data.timestamp).getTime();
      const ageStr = formatAge(age);
      const stale = age > STALE_THRESHOLD_MS;
      const colorFn = stale ? red : green;
      const marker = stale ? red(' [STALE]') : '';

      console.log(
        `  ${agentId}  task=${data.task_id}  heartbeat=${colorFn(ageStr)}${marker}  ${dim(data.last_tool)}`
      );
    } catch {
      // skip corrupted files
    }
  }
}
