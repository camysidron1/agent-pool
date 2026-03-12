import { createInterface } from 'readline';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { bold, green, yellow, dim } from '../util/colors.js';
import type { Project } from '../stores/interfaces.js';
import { buildRunnerCommand } from '../util/runner-command.js';

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise(resolve => {
    rl.question(question, answer => {
      rl.close();
      resolve(answer);
    });
  });
}

export function registerStartCommand(program: Command, ctx: AppContext): void {
  program
    .command('start')
    .description('Interactive guided setup — teardown, init, and launch')
    .action(async () => {
      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      // --- 1. Project selection ---
      const projects = projectService.list();
      if (projects.length === 0) {
        console.error('No projects registered. Run "agent-pool project add" first.');
        process.exit(1);
      }

      let project: Project;
      if (projects.length === 1) {
        project = projects[0];
        console.log(`Using project: ${project.name}`);
      } else {
        console.log('Available projects:');
        projects.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}`));
        const choice = (await prompt('Select project [1]: ')) || '1';
        const idx = parseInt(choice, 10);
        if (isNaN(idx) || idx < 1 || idx > projects.length) {
          console.error('Invalid selection.');
          process.exit(1);
        }
        project = projects[idx - 1];
        console.log(`Selected: ${project.name}`);
      }

      // --- 2. Agent count ---
      const countStr = (await prompt('Number of agents [4]: ')) || '4';
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1) {
        console.error('Invalid count.');
        process.exit(1);
      }

      // --- 3. Skip permissions ---
      const skipAnswer = (await prompt('Skip permissions? [y/N]: ')) || 'n';
      const skipPermissions = /^[yY]/.test(skipAnswer);

      // --- 3b. Agent type ---
      const agentAnswer = (await prompt('Agent type [claude]: ')) || 'claude';
      const agent = agentAnswer.trim() || 'claude';

      // --- 4. Teardown existing sessions ---
      const lockedClones = poolService.list(project.name).filter(c => c.locked);

      if (lockedClones.length > 0) {
        console.log('Tearing down existing sessions...');

        // Group by workspace
        const byWorkspace = new Map<string, number[]>();
        for (const clone of lockedClones) {
          const ws = clone.workspaceId;
          if (!byWorkspace.has(ws)) byWorkspace.set(ws, []);
          byWorkspace.get(ws)!.push(clone.cloneIndex);
        }

        for (const [ws, indexes] of byWorkspace) {
          if (ws.startsWith('surface:')) {
            // Direct surface ref from --here launch
            const surfaceRef = ws.slice('surface:'.length);
            try {
              await ctx.cmux.sendKeys(surfaceRef, '\x03');
              await sleep(200);
              await ctx.cmux.sendKeys(surfaceRef, '\x03');
              await sleep(300);
              await ctx.cmux.closeSurface(surfaceRef);
            } catch {
              // Surface may already be gone
            }
          } else if (!ws.startsWith('here:') && !ws.startsWith('here-')) {
            // Real workspace ref — list and close all surfaces
            try {
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
            } catch {
              // Workspace may already be gone
            }
          }
          // else: here-* legacy IDs — can't close; just release locks

          // Release all locks in this group
          for (const cloneIdx of indexes) {
            poolService.unlock(project.name, cloneIdx);
            console.log(`  Released agent-${String(cloneIdx).padStart(2, '0')}`);
          }
        }

        await sleep(500);
        console.log('Teardown complete.');
      }

      // --- 5. Clean stale locks ---
      await poolService.cleanupStaleLocks(project.name);

      // --- 6. Reset pool — remove old clone dirs, clear DB entries ---
      const existingClones = poolService.list(project.name);
      if (existingClones.length > 0) {
        for (const clone of existingClones) {
          const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
          try {
            rmSync(clonePath, { recursive: true, force: true });
          } catch {
            // Directory may not exist
          }
          poolService.removeClone(project.name, clone.cloneIndex);
        }
      }

      // --- 7. Close other panes in current workspace ---
      const { callerSurface } = await ctx.cmux.identify();
      if (callerSurface) {
        const allSurfaces = await ctx.cmux.listPaneSurfaces();
        for (const surf of allSurfaces) {
          if (surf === callerSurface) continue;
          await ctx.cmux.closeSurface(surf);
        }
      }

      // --- 8. Init clones ---
      console.log(bold(`\nLaunching ${count} agents for '${project.name}'...`));

      const cloneIndexes: number[] = [];
      for (let i = 0; i < count; i++) {
        const clone = await poolService.createClone(
          project.name,
          project.source,
          project.branch,
          project.prefix,
          ctx.config.dataDir,
          project.setup,
        );
        cloneIndexes.push(clone.cloneIndex);
        console.log(green(`  Clone ${clone.cloneIndex} created`));
      }

      console.log(`${count} clones ready.`);

      // --- 9. Launch agents in current workspace as splits ---
      console.log(`Launching ${count} agents in current workspace...`);

      const surfaces: string[] = [];

      // Split right from driver -> agent 1 (top-left of grid)
      if (cloneIndexes.length >= 1) {
        const { surfaceRef } = await ctx.cmux.newSplit('right', {});
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[0], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[0], project, ctx.config.toolDir, { skipPermissions, agent });
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[0], `surface:${surfaceRef}`);
        console.log(dim(`  Agent ${String(cloneIndexes[0]).padStart(2, '0')} (top-left)`));
      }

      // Split agent-1 right -> agent 2 (top-right)
      if (cloneIndexes.length >= 2) {
        const { surfaceRef } = await ctx.cmux.newSplit('right', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[1], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[1], project, ctx.config.toolDir, { skipPermissions, agent });
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[1], `surface:${surfaceRef}`);
        console.log(dim(`  Agent ${String(cloneIndexes[1]).padStart(2, '0')} (top-right)`));
      }

      // Split agent-1 down -> agent 3 (bottom-left)
      if (cloneIndexes.length >= 3) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[2], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[2], project, ctx.config.toolDir, { skipPermissions, agent });
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[2], `surface:${surfaceRef}`);
        console.log(dim(`  Agent ${String(cloneIndexes[2]).padStart(2, '0')} (bottom-left)`));
      }

      // Split agent-2 down -> agent 4 (bottom-right)
      if (cloneIndexes.length >= 4) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[1] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[3], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[3], project, ctx.config.toolDir, { skipPermissions, agent });
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[3], `surface:${surfaceRef}`);
        console.log(dim(`  Agent ${String(cloneIndexes[3]).padStart(2, '0')} (bottom-right)`));
      }

      // Additional agents beyond 4: cycle splits across existing grid cells
      for (let i = 4; i < cloneIndexes.length; i++) {
        const parentIdx = (i - 4) % 4;
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[parentIdx] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[i], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[i], project, ctx.config.toolDir, { skipPermissions, agent });
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[i], `surface:${surfaceRef}`);
        console.log(dim(`  Agent ${String(cloneIndexes[i]).padStart(2, '0')} (extra-${i + 1})`));
      }

      console.log(green(`Done. ${count} agents launched in current workspace.`));

      // --- 10. Install dispatch/update commands into source repo for the driver ---
      const sourceCommandsDir = join(project.source, '.claude', 'commands');
      mkdirSync(sourceCommandsDir, { recursive: true });
      const installedCommands: string[] = [];
      for (const name of ['dispatch.md', 'update.md']) {
        const src = join(ctx.config.toolDir, 'commands', name);
        if (existsSync(src)) {
          const dest = join(sourceCommandsDir, name);
          writeFileSync(dest, readFileSync(src, 'utf-8'));
          installedCommands.push(dest);
        }
      }

      // --- 11. Driver pane: exec claude with startup message ---
      const pendingTasks = ctx.stores.tasks.getAll(project.name).filter(t => t.status === 'pending');
      const pendingCount = pendingTasks.length;

      const startupMsg = `You are the orchestrator of an agent-pool with ${count} active agents for project '${project.name}'. ${pendingCount} pending tasks in queue.

IMPORTANT: You MUST use the agent-pool CLI for all task operations. Never guess file paths or read JSON files directly.

Key commands:
  agent-pool tasks                    — Check task queue (pending, in_progress, completed, blocked)
  agent-pool add "detailed prompt"    — Dispatch a task to an agent
  agent-pool add --priority 5 "..."   — Higher priority (claimed first)
  agent-pool add --depends-on t-1 "." — Task depends on another
  agent-pool status                   — Check clone/agent status
  agent-pool unblock <id>             — Re-queue a blocked task

Run /dispatch for the full orchestrator protocol with prompt-writing guidelines.
Ready to receive tasks.`;

      const claudeArgs = ['claude'];
      if (skipPermissions) claudeArgs.push('--dangerously-skip-permissions');
      claudeArgs.push(startupMsg);

      console.log(yellow(`\nStarting driver in ${project.source}...`));

      // Use spawnSync to block the event loop — prevents Bun's async
      // internals from consuming stdin bytes meant for Claude
      const result = spawnSync(claudeArgs[0], claudeArgs.slice(1), {
        cwd: project.source,
        stdio: 'inherit',
      });

      // Clean up installed commands from source repo
      for (const dest of installedCommands) {
        try { rmSync(dest); } catch { /* best-effort */ }
      }

      process.exit(result.status ?? 0);
    });
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}
