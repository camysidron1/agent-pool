import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { teardownProject } from '../services/teardown.js';
import { bold, green, yellow, dim } from '../util/colors.js';
import type { Project } from '../stores/interfaces.js';
import { buildRunnerCommand } from '../util/runner-command.js';
import { DaemonClient } from '../daemon/client.js';
import { ensureDaemonRunning } from '../util/ensure-daemon.js';

export function registerStartCommand(program: Command, ctx: AppContext): void {
  program
    .command('start')
    .description('Interactive guided setup — teardown, init, and launch')
    .action(async () => {
      // Use Bun's built-in synchronous prompt() — Node's readline hangs
      // on repeated calls under Bun due to stdin event loop issues.
      const ask = (question: string, fallback: string): string =>
        prompt(question) ?? fallback;

      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      // --- 1. Project selection ---
      const projects = projectService.list();
      if (projects.length === 0) {
        console.error('No projects registered. Run "agent-pool project add" first.');
        process.exit(1);
      }

      let project: Project;
      console.log('Available projects:');
      projects.forEach((p, i) => console.log(`  ${i + 1}) ${p.name}`));
      const choice = ask('Select project [1]: ', '1');
      const idx = parseInt(choice, 10);
      if (isNaN(idx) || idx < 1 || idx > projects.length) {
        console.error('Invalid selection.');
        process.exit(1);
      }
      project = projects[idx - 1];
      console.log(`Selected: ${project.name}`);

      // --- 2. Agent count ---
      const countStr = ask('Number of agents [4]: ', '4');
      const count = parseInt(countStr, 10);
      if (isNaN(count) || count < 1) {
        console.error('Invalid count.');
        process.exit(1);
      }

      // --- 3. Skip permissions ---
      const skipAnswer = ask('Skip permissions? [y/N]: ', 'n');
      const skipPermissions = /^[yY]/.test(skipAnswer);

      // --- 3b. Agent type ---
      const defaultAgent = project.agentType || 'claude';
      const agentAnswer = (await prompt(`Agent type (claude/codex) [${defaultAgent}]: `)) || defaultAgent;
      const agent = agentAnswer.trim() || defaultAgent;

      // Workspace scoping: when running inside cmux, only tear down/reset
      // clones belonging to THIS workspace so other pools stay intact.
      const workspaceRef = process.env.CMUX_WORKSPACE_ID || undefined;

      // --- 4. Teardown existing sessions (scoped to current workspace) ---
      const scopedClones = workspaceRef
        ? poolService.listByWorkspace(project.name, workspaceRef)
        : poolService.list(project.name);
      const lockedClones = scopedClones.filter(c => c.locked);
      if (lockedClones.length > 0) {
        console.log('Tearing down existing sessions...');
        await teardownProject(ctx, project.name, poolService, workspaceRef);
        console.log('Teardown complete.');
      }

      // --- 6. Reset pool — remove old clone dirs, clear DB entries (workspace-scoped) ---
      const existingClones = workspaceRef
        ? poolService.listByWorkspace(project.name, workspaceRef)
        : poolService.list(project.name);
      for (const clone of existingClones) {
        const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
        try { rmSync(clonePath, { recursive: true, force: true }); } catch {}
        poolService.removeClone(project.name, clone.cloneIndex);
      }

      // Also remove any clone dirs on disk not tracked in DB (leftover from
      // a crashed or interrupted previous run). Skip when workspace-scoped
      // since orphan dirs may belong to other pools.
      if (!workspaceRef) {
        const prefix = project.prefix + '-';
        let entries: ReturnType<typeof readdirSync> = [];
        try { entries = readdirSync(ctx.config.dataDir, { withFileTypes: true }); } catch {}
        for (const entry of entries) {
          if (entry.isDirectory() && entry.name.startsWith(prefix)) {
            const dirPath = join(ctx.config.dataDir, entry.name);
            try {
              rmSync(dirPath, { recursive: true, force: true });
              console.log(`  Removed orphan dir ${entry.name}`);
            } catch (e: any) {
              console.warn(`  Warning: could not remove ${dirPath}: ${e.message}`);
            }
          }
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

      // --- 8. Ensure daemon is running (reuse existing if another pool started it) ---
      const socketPath = join(ctx.config.dataDir, 'apd.sock');
      const existingClient = new DaemonClient({ socketPath, timeoutMs: 2000 });
      const daemonAlreadyRunning = await existingClient.connect();
      if (daemonAlreadyRunning) {
        existingClient.close();
        console.log(green('Daemon already running.'));
      } else {
        const daemonOk = await ensureDaemonRunning(ctx.config.dataDir, ctx.config.toolDir);
        if (daemonOk) {
          console.log(green('Daemon started.'));
        } else {
          console.warn('Warning: daemon did not start; agents will use polling mode.');
        }
      }

      // --- 8b. If codex + OPENAI_API_KEY, register it with codex's auth system ---
      if (agent === 'codex' && project.envVars?.OPENAI_API_KEY) {
        spawnSync('codex', ['login', '--with-api-key'], {
          input: project.envVars.OPENAI_API_KEY,
          stdio: ['pipe', 'inherit', 'inherit'],
        });
        console.log(green('Codex API key configured.'));
      }

      // --- 9. Init clones ---
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

      // --- 10. Launch agents in current workspace as splits ---
      const runnerOpts = { skipPermissions, agent, workspaceRef };
      console.log(`Launching ${count} agents in current workspace...`);

      const surfaces: string[] = [];

      // Split right from driver -> agent 1 (top-left of grid)
      if (cloneIndexes.length >= 1) {
        const { surfaceRef } = await ctx.cmux.newSplit('right', {});
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[0], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[0], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[0], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[0]).padStart(2, '0')} (top-left)`));
      }

      // Split agent-1 right -> agent 2 (top-right)
      if (cloneIndexes.length >= 2) {
        const { surfaceRef } = await ctx.cmux.newSplit('right', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[1], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[1], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[1], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[1]).padStart(2, '0')} (top-right)`));
      }

      // Split agent-1 down -> agent 3 (bottom-left)
      if (cloneIndexes.length >= 3) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[2], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[2], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[2], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[2]).padStart(2, '0')} (bottom-left)`));
      }

      // Split agent-2 down -> agent 4 (bottom-right)
      if (cloneIndexes.length >= 4) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[1] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[3], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[3], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[3], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[3]).padStart(2, '0')} (bottom-right)`));
      }

      // Additional agents beyond 4: cycle splits across existing grid cells
      for (let i = 4; i < cloneIndexes.length; i++) {
        const parentIdx = (i - 4) % 4;
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[parentIdx] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[i], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[i], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(project.name, cloneIndexes[i], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[i]).padStart(2, '0')} (extra-${i + 1})`));
      }

      console.log(green(`Done. ${count} agents launched in current workspace.`));

      // --- 11. Install dispatch/update commands into source repo for the driver ---
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

      // --- 12. Driver pane: exec claude with startup message ---
      const pendingTasks = ctx.stores.tasks.getAll(project.name).filter(t => t.status === 'pending');
      const pendingCount = pendingTasks.length;

      const p = `-p ${project.name}`;
      const startupMsg = `You are the orchestrator of an agent-pool with ${count} active agents for project '${project.name}'. ${pendingCount} pending tasks in queue.

IMPORTANT: You MUST use the agent-pool CLI for all task operations. Never guess file paths or read JSON files directly.
IMPORTANT: Always pass ${p} to scope commands to this project.

Key commands:
  agent-pool ${p} tasks                    — Check task queue (pending, in_progress, completed, blocked)
  agent-pool ${p} add "detailed prompt"    — Dispatch a task to an agent
  agent-pool ${p} add --priority 5 "..."   — Higher priority (claimed first)
  agent-pool ${p} add --depends-on t-1 "." — Task depends on another
  agent-pool ${p} status                   — Check clone/agent status
  agent-pool ${p} unblock <id>             — Re-queue a blocked task

Run /dispatch for the full orchestrator protocol with prompt-writing guidelines.
Ready to receive tasks.`;

      const driverBin = agent;
      const driverArgs = [driverBin];
      if (agent === 'claude') {
        if (skipPermissions) driverArgs.push('--dangerously-skip-permissions');
        driverArgs.push(startupMsg);
      } else if (agent === 'codex') {
        // Interactive mode for the driver (not exec, which is one-shot)
        if (skipPermissions) driverArgs.push('--full-auto');
        driverArgs.push(startupMsg);
      }

      console.log(yellow(`\nStarting driver in ${project.source}...`));

      // Use spawnSync to block the event loop — prevents Bun's async
      // internals from consuming stdin bytes meant for Claude
      const driverEnv = { ...process.env, ...(project.envVars ?? {}) };
      const result = spawnSync(driverArgs[0], driverArgs.slice(1), {
        cwd: project.source,
        stdio: 'inherit',
        env: driverEnv,
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
