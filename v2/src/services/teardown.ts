import type { AppContext } from '../container.js';
import { PoolService } from './pool-service.js';
import { killRunnerByHeartbeat, sleep } from '../util/kill-runner.js';

export interface TeardownResult {
  agentsKilled: number;
  tasksReleased: number;
}

/**
 * Tear down running agents for a project.
 * When workspaceRef is provided, only affects clones in that workspace.
 * When omitted, tears down ALL clones for the project.
 */
export async function teardownProject(
  ctx: AppContext,
  projectName: string,
  poolService: PoolService,
  workspaceRef?: string,
): Promise<TeardownResult> {
  const allLocked = poolService.list(projectName).filter(c => c.locked);
  const lockedClones = workspaceRef
    ? allLocked.filter(c => c.workspaceRef === workspaceRef)
    : allLocked;
  let agentsKilled = 0;

  if (lockedClones.length > 0) {
    // Kill runner processes by PID first (more reliable than Ctrl+C)
    for (const clone of lockedClones) {
      const agentId = `agent-${String(clone.cloneIndex).padStart(2, '0')}`;
      const killed = await killRunnerByHeartbeat(ctx.config.dataDir, agentId);
      if (killed) agentsKilled++;
    }

    // Group by workspace for surface cleanup
    const byWorkspace = new Map<string, number[]>();
    for (const clone of lockedClones) {
      const ws = clone.workspaceId;
      if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
      byWorkspace.get(ws)!.push(clone.cloneIndex);
    }

    for (const [ws, indexes] of byWorkspace) {
      try {
        if (ws && ws.startsWith('surface:')) {
          const surfaceRef = ws.slice('surface:'.length);
          await ctx.cmux.sendKeys(surfaceRef, '\x03');
          await sleep(200);
          await ctx.cmux.sendKeys(surfaceRef, '\x03');
          await sleep(300);
          await ctx.cmux.closeSurface(surfaceRef);
        } else if (ws && !ws.startsWith('here:') && !ws.startsWith('here-')) {
          const panes = await ctx.cmux.listPanes(ws);
          for (const pane of panes) {
            await ctx.cmux.sendKeys(pane.id, '\x03');
            await sleep(200);
            await ctx.cmux.sendKeys(pane.id, '\x03');
          }
          await sleep(500);
          for (const pane of panes) {
            await ctx.cmux.closeSurface(pane.id);
          }
        }
      } catch {
        // Surface/workspace may already be gone
      }

      for (const cloneIdx of indexes) {
        poolService.unlock(projectName, cloneIdx);
        console.log(`  Released agent-${String(cloneIdx).padStart(2, '0')}`);
      }
    }

    await sleep(500);
  }

  // Clean stale locks
  await poolService.cleanupStaleLocks(projectName);

  // Release stuck in_progress tasks (only for agents we tore down)
  let tasksReleased = 0;
  const tornDownAgentIds = new Set(
    lockedClones.map(c => `agent-${String(c.cloneIndex).padStart(2, '0')}`)
  );
  const stuckAgents = new Set(
    ctx.stores.tasks.getAll(projectName)
      .filter(t => t.status === 'in_progress' && t.claimedBy && tornDownAgentIds.has(t.claimedBy))
      .map(t => t.claimedBy!)
  );
  for (const agentId of stuckAgents) {
    const released = ctx.stores.tasks.releaseAgent(projectName, agentId);
    if (released > 0) {
      tasksReleased += released;
      console.log(`  Released ${released} stuck task(s) for ${agentId}`);
    }
  }

  return { agentsKilled, tasksReleased };
}
