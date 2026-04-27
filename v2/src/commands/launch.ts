import type { Command } from 'commander';
import { spawnSync } from 'child_process';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { bold, green, yellow } from '../util/colors.js';
import type { Clone, Project } from '../stores/interfaces.js';
import { buildRunnerCommand } from '../util/runner-command.js';
import { ensureDaemonRunning } from '../util/ensure-daemon.js';

export async function launchAgents(
  ctx: AppContext,
  program: Command,
  opts: {
    grid?: boolean;
    panel?: boolean;
    down?: boolean;
    right?: boolean;
    workspace?: boolean;
    here?: boolean;
    env?: string;
    skipPermissions?: boolean;
    queue?: boolean;
    push?: boolean;
    driver?: boolean;
    agent?: string;
  },
): Promise<void> {
  const projectService = new ProjectService(ctx.stores.projects);
  const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

  const globalOpts = program.opts();
  const project = projectService.resolve(globalOpts.project);

  if (opts.queue !== false && opts.push !== false) {
    const ok = await ensureDaemonRunning(ctx.config.dataDir, ctx.config.toolDir);
    if (!ok) {
      console.warn('Warning: daemon did not start; agents will fall back to polling mode.');
    }
  }

  // Clean up stale locks first
  await poolService.cleanupStaleLocks(project.name);

  if (opts.here) {
    await launchHere(ctx, poolService, project, opts);
    return;
  }

  if (opts.workspace) {
    await launchWorkspace(ctx, poolService, project, opts);
    return;
  }

  if (opts.panel) {
    await launchPanel(ctx, poolService, project, opts);
    return;
  }

  // Default: grid mode
  await launchGrid(ctx, poolService, project, opts);
}

async function findOrCreateClone(
  ctx: AppContext,
  poolService: PoolService,
  project: Project,
): Promise<Clone | null> {
  let clone = poolService.findFree(project.name);
  if (!clone) {
    // Try to create a new one
    try {
      clone = await poolService.createClone(
        project.name,
        project.source,
        project.branch,
        project.prefix,
        ctx.config.dataDir,
        project.setup,
      );
    } catch {
      return null;
    }
  }
  return clone;
}

async function launchGrid(
  ctx: AppContext,
  poolService: PoolService,
  project: Project,
  opts: { env?: string; skipPermissions?: boolean; queue?: boolean; driver?: boolean; agent?: string },
): Promise<void> {
  const maxPanes = 4;
  const clones: Clone[] = [];

  for (let i = 0; i < maxPanes; i++) {
    const clone = await findOrCreateClone(ctx, poolService, project);
    if (!clone) break;
    clones.push(clone);
  }

  if (clones.length === 0) {
    console.error('No clones available. Run init first.');
    process.exit(1);
  }

  console.log(bold(`Launching ${clones.length} agents in grid for '${project.name}'...`));

  // Create workspace first, then send commands with workspace ref
  const { workspaceRef, surfaceRef: firstSurface } = await ctx.cmux.newWorkspace({});
  await ctx.cmux.renameWorkspace(workspaceRef, `${project.name}-pool`);

  const optsWithWs = { ...opts, workspaceRef };
  const surfaces = [firstSurface];

  // First agent in the initial surface
  const firstClone = clones[0];
  const firstPath = poolService.getClonePath(project.prefix, firstClone.cloneIndex, ctx.config.dataDir);
  const firstCmd = buildRunnerCommand(firstPath, firstClone.cloneIndex, project, ctx.config.toolDir, optsWithWs);
  await ctx.cmux.send({ surface: firstSurface }, firstCmd);
  poolService.lock(project.name, firstClone.cloneIndex, workspaceRef, workspaceRef);

  // Create remaining panes in 2x2 grid: right split, then two down splits
  if (clones.length >= 2) {
    const { surfaceRef } = await ctx.cmux.newSplit('right', { workspace: workspaceRef, surface: firstSurface });
    surfaces.push(surfaceRef);
    const path = poolService.getClonePath(project.prefix, clones[1].cloneIndex, ctx.config.dataDir);
    const cmd = buildRunnerCommand(path, clones[1].cloneIndex, project, ctx.config.toolDir, optsWithWs);
    await ctx.cmux.send({ surface: surfaceRef }, cmd);
    poolService.lock(project.name, clones[1].cloneIndex, workspaceRef, workspaceRef);
  }

  if (clones.length >= 3) {
    const { surfaceRef } = await ctx.cmux.newSplit('down', { workspace: workspaceRef, surface: firstSurface });
    surfaces.push(surfaceRef);
    const path = poolService.getClonePath(project.prefix, clones[2].cloneIndex, ctx.config.dataDir);
    const cmd = buildRunnerCommand(path, clones[2].cloneIndex, project, ctx.config.toolDir, optsWithWs);
    await ctx.cmux.send({ surface: surfaceRef }, cmd);
    poolService.lock(project.name, clones[2].cloneIndex, workspaceRef, workspaceRef);
  }

  if (clones.length >= 4) {
    const { surfaceRef } = await ctx.cmux.newSplit('down', { workspace: workspaceRef, surface: surfaces[1] });
    surfaces.push(surfaceRef);
    const path = poolService.getClonePath(project.prefix, clones[3].cloneIndex, ctx.config.dataDir);
    const cmd = buildRunnerCommand(path, clones[3].cloneIndex, project, ctx.config.toolDir, optsWithWs);
    await ctx.cmux.send({ surface: surfaceRef }, cmd);
    poolService.lock(project.name, clones[3].cloneIndex, workspaceRef, workspaceRef);
  }

  // Optional driver pane
  if (opts.driver !== false && clones.length >= 2) {
    const { surfaceRef: driverSurface } = await ctx.cmux.newSplit('right', { workspace: workspaceRef });
    await ctx.cmux.send({ surface: driverSurface }, `cd ${project.source} && claude`);
  }

  console.log(green(`Launched ${clones.length} agents in workspace '${project.name}-pool'`));
}

async function launchPanel(
  ctx: AppContext,
  poolService: PoolService,
  project: Project,
  opts: { env?: string; skipPermissions?: boolean; queue?: boolean; down?: boolean; right?: boolean; agent?: string },
): Promise<void> {
  const clone = await findOrCreateClone(ctx, poolService, project);
  if (!clone) {
    console.error('No clones available. Run init first.');
    process.exit(1);
  }

  const wsRef = process.env.CMUX_WORKSPACE_ID || undefined;
  const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
  const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, { ...opts, workspaceRef: wsRef });

  const direction = opts.down ? 'down' : 'right';
  const { surfaceRef } = await ctx.cmux.newSplit(direction, { workspace: wsRef });
  await ctx.cmux.send({ surface: surfaceRef }, cmd);

  const lockId = wsRef || `panel:${clone.cloneIndex}`;
  poolService.lock(project.name, clone.cloneIndex, lockId, wsRef);

  console.log(green(`Launched agent ${clone.cloneIndex} in panel`));
}

async function launchWorkspace(
  ctx: AppContext,
  poolService: PoolService,
  project: Project,
  opts: { env?: string; skipPermissions?: boolean; queue?: boolean; agent?: string },
): Promise<void> {
  const clone = await findOrCreateClone(ctx, poolService, project);
  if (!clone) {
    console.error('No clones available. Run init first.');
    process.exit(1);
  }

  const { workspaceRef } = await ctx.cmux.newWorkspace({});
  await ctx.cmux.renameWorkspace(workspaceRef, `${project.name}-${clone.cloneIndex}`);

  const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
  const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, { ...opts, workspaceRef });
  // cmux newWorkspace already has a surface — identify it and send the command
  const surfaces = await ctx.cmux.listPaneSurfaces(workspaceRef);
  if (surfaces.length > 0) {
    await ctx.cmux.send({ surface: surfaces[0] }, cmd);
  }
  poolService.lock(project.name, clone.cloneIndex, workspaceRef, workspaceRef);

  console.log(green(`Launched agent ${clone.cloneIndex} in workspace '${project.name}-${clone.cloneIndex}'`));
}

async function launchHere(
  ctx: AppContext,
  poolService: PoolService,
  project: Project,
  opts: { env?: string; skipPermissions?: boolean; queue?: boolean; agent?: string },
): Promise<void> {
  const clone = await findOrCreateClone(ctx, poolService, project);
  if (!clone) {
    console.error('No clones available. Run init first.');
    process.exit(1);
  }

  const hereWsRef = process.env.CMUX_WORKSPACE_ID || undefined;
  const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
  const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, { ...opts, workspaceRef: hereWsRef });

  poolService.lock(project.name, clone.cloneIndex, `here:${clone.cloneIndex}`, hereWsRef);
  console.log(green(`Running agent ${clone.cloneIndex} in current terminal`));
  console.log(`  ${cmd}`);

  // Use spawnSync to block the event loop — prevents Bun's async
  // internals from consuming stdin bytes meant for the child process
  spawnSync('sh', ['-c', cmd], {
    stdio: 'inherit',
  });

  poolService.unlock(project.name, clone.cloneIndex);
}

export function registerLaunchCommand(program: Command, ctx: AppContext): void {
  program
    .command('launch')
    .description('Launch agents')
    .option('--grid', 'Grid layout (default)')
    .option('--panel', 'Single split panel')
    .option('--down', 'Split downward (panel mode)')
    .option('--right', 'Split rightward (panel mode, default)')
    .option('--workspace', 'New workspace')
    .option('--here', 'Launch in current terminal')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--no-queue', 'Run without task queue')
    .option('--no-push', 'Disable daemon push mode (use polling)')
    .option('--no-driver', 'Skip driver pane')
    .option('--agent <type>', 'Agent type (claude, codex, or pi)')
    .action(async (opts: {
      grid?: boolean;
      panel?: boolean;
      down?: boolean;
      right?: boolean;
      workspace?: boolean;
      here?: boolean;
      env?: string;
      skipPermissions?: boolean;
      queue?: boolean;
      push?: boolean;
      driver?: boolean;
      agent?: string;
    }) => {
      await launchAgents(ctx, program, opts);
    });
}
