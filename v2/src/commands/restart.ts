import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { green } from '../util/colors.js';
import { buildRunnerCommand } from '../util/runner-command.js';
import { ensureDaemonRunning } from '../util/ensure-daemon.js';
import { killRunnerByHeartbeat, sleep } from '../util/kill-runner.js';

/**
 * Try to restart an agent in its existing pane.
 * First tries to kill the runner process by PID (from heartbeat), then
 * falls back to Ctrl-C. Using PID-based kill is more reliable because
 * Claude Code traps SIGINT, preventing Ctrl-C from reaching the runner.
 */
async function restartInExistingPane(
  ctx: AppContext,
  workspaceId: string,
  cmd: string,
  agentId?: string,
): Promise<boolean> {
  try {
    // Try PID-based kill first (more reliable than Ctrl-C)
    if (agentId) {
      await killRunnerByHeartbeat(ctx.config.dataDir, agentId);
    }

    if (workspaceId.startsWith('surface:')) {
      const surfaceRef = workspaceId.slice('surface:'.length);
      // Also send Ctrl-C as belt-and-suspenders (handles cases with no heartbeat)
      await ctx.cmux.sendKeys(surfaceRef, '\x03');
      await sleep(300);
      await ctx.cmux.sendKeys(surfaceRef, '\x03');
      await sleep(500);
      // Send new runner command
      await ctx.cmux.send({ surface: surfaceRef }, cmd);
      return true;
    }

    if (workspaceId.startsWith('workspace:')) {
      const panes = await ctx.cmux.listPanes(workspaceId);
      if (panes.length > 0) {
        const paneId = panes[0].id;
        await ctx.cmux.sendKeys(paneId, '\x03');
        await sleep(300);
        await ctx.cmux.sendKeys(paneId, '\x03');
        await sleep(500);
        await ctx.cmux.send({ surface: paneId }, cmd);
        return true;
      }
    }
  } catch {
    // Pane/workspace may no longer exist
  }
  return false;
}

/**
 * Hard restart: do not trust the existing pane state.
 * If we have an exact surface ref, close it and launch a fresh split.
 * For shared workspace refs, launch a fresh split in that workspace and
 * rebind the clone to the new surface-specific lock id.
 */
async function hardRestartInFreshPane(ctx: AppContext, workspaceId: string | null, cmd: string): Promise<string> {
  let splitOpts: { workspace?: string; surface?: string } = {};

  if (workspaceId?.startsWith('surface:')) {
    const surfaceRef = workspaceId.slice('surface:'.length);
    try {
      await ctx.cmux.sendKeys(surfaceRef, '\x03');
      await sleep(200);
    } catch {
      // Pane may already be gone
    }
    await ctx.cmux.closeSurface(surfaceRef);

    const identified = await ctx.cmux.identify();
    if (identified.workspaceRef) {
      splitOpts = { workspace: identified.workspaceRef };
    }
  } else if (workspaceId?.startsWith('workspace:')) {
    splitOpts = { workspace: workspaceId };
  }

  const { surfaceRef } = await ctx.cmux.newSplit('right', splitOpts);
  await ctx.cmux.send({ surface: surfaceRef }, cmd);
  return `surface:${surfaceRef}`;
}

async function closeOldAgentSurface(ctx: AppContext, workspaceId: string | null): Promise<void> {
  if (!workspaceId?.startsWith('surface:')) return;
  const surfaceRef = workspaceId.slice('surface:'.length);
  try {
    await ctx.cmux.sendKeys(surfaceRef, '\x03');
    await sleep(200);
  } catch {
    // best-effort
  }
  await ctx.cmux.closeSurface(surfaceRef);
}

async function hardRestartGrid(
  ctx: AppContext,
  projectName: string,
  target: Array<{ cloneIndex: number; workspaceId: string; cmd: string }>,
  poolService: PoolService,
  workspaceRef?: string,
): Promise<void> {
  // Close existing agent surfaces first so they cannot keep stale sessions alive.
  for (const item of target) {
    await closeOldAgentSurface(ctx, item.workspaceId);
  }

  const identified = await ctx.cmux.identify();
  const anchorSurface = identified.callerSurface || undefined;
  const surfaces: string[] = [];

  if (target.length >= 1) {
    const { surfaceRef } = await ctx.cmux.newSplit('right', anchorSurface ? { surface: anchorSurface } : {});
    surfaces.push(surfaceRef);
    await ctx.cmux.send({ surface: surfaceRef }, target[0].cmd);
    poolService.lock(projectName, target[0].cloneIndex, `surface:${surfaceRef}`, workspaceRef);
  }

  if (target.length >= 2) {
    const { surfaceRef } = await ctx.cmux.newSplit('right', { surface: surfaces[0] });
    surfaces.push(surfaceRef);
    await ctx.cmux.send({ surface: surfaceRef }, target[1].cmd);
    poolService.lock(projectName, target[1].cloneIndex, `surface:${surfaceRef}`, workspaceRef);
  }

  if (target.length >= 3) {
    const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[0] });
    surfaces.push(surfaceRef);
    await ctx.cmux.send({ surface: surfaceRef }, target[2].cmd);
    poolService.lock(projectName, target[2].cloneIndex, `surface:${surfaceRef}`, workspaceRef);
  }

  if (target.length >= 4) {
    const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[1] });
    surfaces.push(surfaceRef);
    await ctx.cmux.send({ surface: surfaceRef }, target[3].cmd);
    poolService.lock(projectName, target[3].cloneIndex, `surface:${surfaceRef}`, workspaceRef);
  }

  // Additional agents beyond 4: keep splitting downward from the first four panes.
  for (let i = 4; i < target.length; i++) {
    const parentIdx = (i - 4) % 4;
    const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[parentIdx] });
    surfaces.push(surfaceRef);
    await ctx.cmux.send({ surface: surfaceRef }, target[i].cmd);
    poolService.lock(projectName, target[i].cloneIndex, `surface:${surfaceRef}`, workspaceRef);
  }
}

export function registerRestartCommand(program: Command, ctx: AppContext): void {
  program
    .command('restart')
    .description('Refresh and relaunch agent')
    .argument('[index]', 'Clone index')
    .option('--env <name>', 'Environment name')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--hard', 'Close old pane when possible and relaunch in a fresh split')
    .option('--no-queue', 'Run without task queue')
    .option('--no-push', 'Disable daemon push mode (use polling)')
    .option('--agent <type>', 'Agent type (claude, codex, or pi)')
    .option('--all', 'Restart agents in all workspaces')
    .action(async (indexStr: string | undefined, opts: {
      env?: string;
      skipPermissions?: boolean;
      hard?: boolean;
      queue?: boolean;
      push?: boolean;
      agent?: string;
      all?: boolean;
    }) => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      const globalOpts = program.opts();
      const project = projectService.resolve(globalOpts.project);

      const workspaceRef = opts.all ? undefined : (process.env.CMUX_WORKSPACE_ID || undefined);
      const clones = workspaceRef
        ? poolService.listByWorkspace(project.name, workspaceRef)
        : poolService.list(project.name);
      if (clones.length === 0) {
        console.error('No clones found. Run init first.');
        process.exit(1);
      }

      if (opts.queue !== false && opts.push !== false) {
        const ok = await ensureDaemonRunning(ctx.config.dataDir, ctx.config.toolDir);
        if (!ok) {
          console.warn('Warning: daemon did not start; agents will fall back to polling mode.');
        }
      }

      let targetClones = clones;
      if (indexStr !== undefined) {
        const index = parseInt(indexStr, 10);
        if (isNaN(index)) {
          console.error('Error: index must be a number');
          process.exit(1);
        }
        const clone = ctx.stores.clones.get(project.name, index);
        if (!clone) {
          console.error(`Error: clone ${index} not found for project '${project.name}'`);
          process.exit(1);
        }
        targetClones = [clone];
      }

      for (const clone of targetClones) {
        // Release any stuck in_progress tasks for this agent
        const agentId = `agent-${String(clone.cloneIndex).padStart(2, '0')}`;
        const released = ctx.stores.tasks.releaseAgent(project.name, agentId);
        if (released > 0) {
          console.log(`Released ${released} stuck task(s) for ${agentId}`);
        }
      }

      const restartTargets: Array<{ cloneIndex: number; workspaceId: string; cmd: string }> = [];
      for (const clone of targetClones) {
        // Build runner command
        const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, clone.cloneIndex, project, ctx.config.toolDir, { ...opts, workspaceRef });
        restartTargets.push({ cloneIndex: clone.cloneIndex, workspaceId: clone.workspaceId, cmd });
      }

      // Hard full restart (no index): rebuild a 2x2 grid anchored to the dispatch pane.
      if (opts.hard && indexStr === undefined) {
        for (const clone of targetClones) {
          await poolService.refreshClone(
            project.name,
            clone.cloneIndex,
            project.branch,
            ctx.config.dataDir,
            project.prefix,
          );
        }
        await hardRestartGrid(ctx, project.name, restartTargets, poolService, workspaceRef);
        for (const clone of restartTargets) {
          console.log(green(`Hard restarted clone ${clone.cloneIndex} in fresh grid pane`));
        }
        return;
      }

      for (const clone of targetClones) {
        // Refresh
        await poolService.refreshClone(
          project.name,
          clone.cloneIndex,
          project.branch,
          ctx.config.dataDir,
          project.prefix,
        );

        const target = restartTargets.find(t => t.cloneIndex === clone.cloneIndex)!;
        const cmd = target.cmd;

        if (opts.hard) {
          const newWorkspaceId = await hardRestartInFreshPane(ctx, clone.workspaceId, cmd);
          poolService.lock(project.name, clone.cloneIndex, newWorkspaceId, workspaceRef);
          console.log(green(`Hard restarted clone ${clone.cloneIndex} in fresh pane`));
          continue;
        }

        // Try to restart in existing pane/surface
        if (clone.workspaceId) {
          const agentId = `agent-${String(clone.cloneIndex).padStart(2, '0')}`;
          const restarted = await restartInExistingPane(ctx, clone.workspaceId, cmd, agentId);
          if (restarted) {
            poolService.lock(project.name, clone.cloneIndex, clone.workspaceId, workspaceRef);
            console.log(green(`Restarted clone ${clone.cloneIndex} in existing pane`));
            continue;
          }
        }

        // Fallback: launch as a new split in the current workspace
        const { surfaceRef } = await ctx.cmux.newSplit('right', {});
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, clone.cloneIndex, `surface:${surfaceRef}`, workspaceRef);
        console.log(green(`Restarted clone ${clone.cloneIndex} in new split`));
      }
    });
}
