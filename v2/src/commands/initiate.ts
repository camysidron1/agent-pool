import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import type { Command } from 'commander';
import type { AppContext } from '../container.js';
import { ProjectService } from '../services/project-service.js';
import { PoolService } from '../services/pool-service.js';
import { teardownProject } from '../services/teardown.js';
import { bold, green, yellow, dim } from '../util/colors.js';
import { buildRunnerCommand } from '../util/runner-command.js';
import { DaemonClient } from '../daemon/client.js';
import { ensureDaemonRunning } from '../util/ensure-daemon.js';
import type { Project } from '../stores/interfaces.js';

const PROJECTS_BASE = join(process.env.HOME!, 'Documents', 'agent-pool-projects');

const DEFAULT_GITIGNORE = `node_modules/
.env
.env.*
dist/
build/
.DS_Store
*.log
agent-docs/
shared-docs/
`;

export function registerInitiateCommand(program: Command, ctx: AppContext): void {
  program
    .command('initiate')
    .description('Bootstrap a new project from scratch and launch agents')
    .argument('[name]', 'Project name (re-launches if project already exists)')
    .option('--skip-permissions', 'Skip permission prompts')
    .option('--agent <type>', 'Agent type (claude, codex)', 'claude')
    .option('-n, --count <count>', 'Number of agents', '4')
    .action(async (nameArg: string | undefined, opts: { skipPermissions?: boolean; agent: string; count: string }) => {
      const ask = (question: string, fallback: string): string =>
        prompt(question) ?? fallback;

      const projectService = new ProjectService(ctx.stores.projects);
      const poolService = new PoolService(ctx.stores.clones, ctx.git, ctx.cmux);

      // --- Identify caller pane/surface for later refocus + driver launch ---
      let callerPaneRef: string | null = null;
      let callerSurfaceRef: string | null = null;
      try {
        const idResult = spawnSync('cmux', ['identify', '--json'], { stdio: ['pipe', 'pipe', 'pipe'] });
        if (idResult.status === 0) {
          const idData = JSON.parse(idResult.stdout.toString());
          callerPaneRef = idData?.caller?.pane_ref || null;
          callerSurfaceRef = idData?.caller?.surface_ref || null;
        }
      } catch { /* best-effort */ }

      // --- Determine if this is a new project or a re-launch ---
      let projectName = nameArg?.trim() || '';
      let description = '';
      let techStack = '';
      let isResume = false;

      const existingProject = projectName ? projectService.get(projectName) : null;

      if (existingProject) {
        // --- Resume mode: project already exists ---
        isResume = true;
        console.log(green(`Resuming project '${projectName}'...`));

        // Try to read description/tech from CLAUDE.md
        const claudeMdPath = join(existingProject.source, 'CLAUDE.md');
        if (existsSync(claudeMdPath)) {
          const parsed = parseClaudeMd(readFileSync(claudeMdPath, 'utf-8'));
          description = parsed.description;
          techStack = parsed.techStack;
        }
      } else {
        // --- New project: interactive prompts ---
        if (!projectName) {
          projectName = ask('Project name: ', '').trim();
        }
        if (!projectName) {
          console.error('Project name is required.');
          process.exit(1);
        }
        if (/\s/.test(projectName)) {
          console.error('Project name cannot contain spaces.');
          process.exit(1);
        }
        if (projectService.get(projectName)) {
          // Shouldn't hit this (caught above), but guard anyway
          isResume = true;
        } else {
          description = ask('Describe your project (1-3 sentences): ', '').trim();
          if (!description) {
            console.error('Project description is required.');
            process.exit(1);
          }
          techStack = ask('Language/framework (e.g. TypeScript/React) [any]: ', '').trim();
        }
      }

      const skipAnswer = isResume ? 'n' : ask('Skip permissions? [y/N]: ', 'n');
      const skipPermissions = opts.skipPermissions || /^[yY]/.test(skipAnswer);
      const agent = opts.agent || 'claude';
      const count = parseInt(opts.count, 10) || 4;

      let project: Project;
      let projectDir: string;

      if (isResume) {
        // --- Resume: use existing project ---
        project = projectService.resolve(projectName);
        projectDir = project.source;
      } else {
        // --- New project: create directory and register ---
        mkdirSync(PROJECTS_BASE, { recursive: true });
        projectDir = join(PROJECTS_BASE, projectName);

        if (existsSync(projectDir)) {
          console.error(`Directory already exists: ${projectDir}`);
          process.exit(1);
        }
        mkdirSync(projectDir, { recursive: true });

        console.log(bold(`\nCreating project '${projectName}'...`));

        // Scaffold files
        writeFileSync(join(projectDir, 'README.md'), `# ${projectName}\n\n${description}\n`);
        writeFileSync(join(projectDir, 'CLAUDE.md'), buildClaudeMd(projectName, description, techStack));
        writeFileSync(join(projectDir, '.gitignore'), DEFAULT_GITIGNORE);

        // Git init + initial commit
        spawnSync('git', ['init'], { cwd: projectDir, stdio: 'pipe' });
        spawnSync('git', ['add', '.'], { cwd: projectDir, stdio: 'pipe' });
        spawnSync('git', ['commit', '-m', 'Initial project scaffold'], { cwd: projectDir, stdio: 'pipe' });

        console.log(green('  Project directory created and initialized.'));

        // Register project
        projectService.add({
          name: projectName,
          source: projectDir,
          branch: 'main',
          prefix: projectName,
        });
        projectService.setDefault(projectName);
        project = projectService.resolve(projectName);
        console.log(green(`  Project '${projectName}' registered.`));
      }

      // --- Teardown existing sessions if re-launching ---
      const workspaceRef = process.env.CMUX_WORKSPACE_ID || undefined;

      if (isResume) {
        const scopedClones = workspaceRef
          ? poolService.listByWorkspace(projectName, workspaceRef)
          : poolService.list(projectName);
        const lockedClones = scopedClones.filter(c => c.locked);
        if (lockedClones.length > 0) {
          console.log('Tearing down existing sessions...');
          await teardownProject(ctx, projectName, poolService, workspaceRef);
          console.log('Teardown complete.');
        }

        // Reset pool — remove old clone dirs, clear DB entries
        const existingClones = workspaceRef
          ? poolService.listByWorkspace(projectName, workspaceRef)
          : poolService.list(projectName);
        for (const clone of existingClones) {
          const clonePath = poolService.getClonePath(project.prefix, clone.cloneIndex, ctx.config.dataDir);
          try { rmSync(clonePath, { recursive: true, force: true }); } catch {}
          poolService.removeClone(projectName, clone.cloneIndex);
        }

        // Clean up orphan dirs on disk
        if (!workspaceRef) {
          const prefix = project.prefix + '-';
          let entries: ReturnType<typeof readdirSync> = [];
          try { entries = readdirSync(ctx.config.dataDir, { withFileTypes: true }); } catch {}
          for (const entry of entries) {
            if (entry.isDirectory() && entry.name.startsWith(prefix)) {
              const dirPath = join(ctx.config.dataDir, entry.name);
              try { rmSync(dirPath, { recursive: true, force: true }); } catch {}
            }
          }
        }
      }

      // --- Close other panes in current workspace ---
      const { callerSurface } = await ctx.cmux.identify();
      if (callerSurface) {
        const allSurfaces = await ctx.cmux.listPaneSurfaces();
        for (const surf of allSurfaces) {
          if (surf === callerSurface) continue;
          await ctx.cmux.closeSurface(surf);
        }
      }

      // --- Ensure daemon ---
      const socketPath = join(ctx.config.dataDir, 'apd.sock');
      const existingClient = new DaemonClient({ socketPath, timeoutMs: 2000 });
      const daemonAlreadyRunning = await existingClient.connect();
      if (daemonAlreadyRunning) {
        existingClient.close();
        console.log(green('  Daemon already running.'));
      } else {
        const daemonOk = await ensureDaemonRunning(ctx.config.dataDir, ctx.config.toolDir);
        if (daemonOk) {
          console.log(green('  Daemon started.'));
        } else {
          console.warn('  Warning: daemon did not start; agents will use polling mode.');
        }
      }

      // --- Create clones ---
      console.log(bold(`\nLaunching ${count} agents for '${projectName}'...`));

      const cloneIndexes: number[] = [];
      for (let i = 0; i < count; i++) {
        const clone = await poolService.createClone(
          projectName,
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

      // --- Launch agents in current workspace as 2x2 grid ---
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
        poolService.lock(projectName, cloneIndexes[0], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[0]).padStart(2, '0')} (top-left)`));
      }

      // Split agent-1 right -> agent 2 (top-right)
      if (cloneIndexes.length >= 2) {
        const { surfaceRef } = await ctx.cmux.newSplit('right', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[1], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[1], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(projectName, cloneIndexes[1], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[1]).padStart(2, '0')} (top-right)`));
      }

      // Split agent-1 down -> agent 3 (bottom-left)
      if (cloneIndexes.length >= 3) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[0] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[2], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[2], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(projectName, cloneIndexes[2], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[2]).padStart(2, '0')} (bottom-left)`));
      }

      // Split agent-2 down -> agent 4 (bottom-right)
      if (cloneIndexes.length >= 4) {
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[1] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[3], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[3], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(projectName, cloneIndexes[3], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[3]).padStart(2, '0')} (bottom-right)`));
      }

      // Additional agents beyond 4
      for (let i = 4; i < cloneIndexes.length; i++) {
        const parentIdx = (i - 4) % 4;
        const { surfaceRef } = await ctx.cmux.newSplit('down', { surface: surfaces[parentIdx] });
        surfaces.push(surfaceRef);
        const clonePath = poolService.getClonePath(project.prefix, cloneIndexes[i], ctx.config.dataDir);
        const cmd = buildRunnerCommand(clonePath, cloneIndexes[i], project, ctx.config.toolDir, runnerOpts);
        await ctx.cmux.send({ surface: surfaceRef }, cmd);
        poolService.lock(projectName, cloneIndexes[i], `surface:${surfaceRef}`, workspaceRef);
        console.log(dim(`  Agent ${String(cloneIndexes[i]).padStart(2, '0')} (extra-${i + 1})`));
      }

      console.log(green(`Done. ${count} agents launched in current workspace.`));

      // --- Install dispatch/update commands into project ---
      const sourceCommandsDir = join(projectDir, '.claude', 'commands');
      mkdirSync(sourceCommandsDir, { recursive: true });
      for (const name of ['dispatch.md', 'update.md']) {
        const src = join(ctx.config.toolDir, 'commands', name);
        if (existsSync(src)) {
          writeFileSync(join(sourceCommandsDir, name), readFileSync(src, 'utf-8'));
        }
      }

      // --- Launch driver with greenfield prompt ---
      const startupMsg = buildGreenfieldPrompt(projectName, description, techStack, count);
      const driverBin = agent;

      // Build the driver shell command and write to a launch script
      // (avoids shell-escaping the multi-line prompt)
      const launchScript = join(ctx.config.dataDir, `.initiate-driver-${projectName}.sh`);
      const driverFlags = [];
      if (agent === 'claude' && skipPermissions) driverFlags.push('--dangerously-skip-permissions');
      if (agent === 'codex' && skipPermissions) driverFlags.push('--full-auto');

      writeFileSync(launchScript, [
        '#!/bin/bash',
        `cd ${shellQuote(projectDir)}`,
        `rm -f ${shellQuote(launchScript)}`,
        `exec ${driverBin} ${driverFlags.join(' ')} ${shellQuote(startupMsg)}`.trim(),
      ].join('\n') + '\n', { mode: 0o755 });

      // Focus caller pane, then send the launch command via cmux after we exit.
      // Using cmux send guarantees the driver starts in the caller's pane
      // regardless of which pane has focus after the agent splits.
      const targetSurface = callerSurfaceRef || callerSurface;

      if (callerPaneRef) {
        spawnSync('cmux', ['focus-pane', '--pane', callerPaneRef], { stdio: 'pipe' });
      }

      if (targetSurface) {
        // Background process: wait for us to exit, then send the driver command
        Bun.spawn(['bash', '-c', `sleep 0.5 && cmux send --surface ${targetSurface} -- "bash ${shellQuote(launchScript)}"`], {
          stdio: ['ignore', 'ignore', 'ignore'],
        });
        console.log(yellow(`\nDriver starting in ${projectDir}...`));
      } else {
        // Fallback: spawnSync if we can't identify the caller surface
        console.log(yellow(`\nStarting driver in ${projectDir}...`));
        const result = spawnSync(driverBin, [...driverFlags, startupMsg], {
          cwd: projectDir,
          stdio: 'inherit',
          env: { ...process.env, ...(project.envVars ?? {}) },
        });
        try { rmSync(launchScript); } catch {}
        process.exit(result.status ?? 0);
      }

      process.exit(0);
    });
}

function shellQuote(s: string): string {
  return "'" + s.replace(/'/g, "'\\''") + "'";
}

/** Parse description and tech stack from a CLAUDE.md written by initiate */
function parseClaudeMd(content: string): { description: string; techStack: string } {
  let description = '';
  let techStack = '';

  const visionMatch = content.match(/## Project Vision\n\n([\s\S]*?)(?=\n## |\n$)/);
  if (visionMatch) description = visionMatch[1].trim();

  const techMatch = content.match(/## Tech Stack\n\n([\s\S]*?)(?=\n## |\n$)/);
  if (techMatch) techStack = techMatch[1].trim();

  return { description, techStack };
}

function buildClaudeMd(name: string, description: string, techStack: string): string {
  const lines = [
    `# ${name}`,
    '',
    `## Project Vision`,
    '',
    description,
    '',
  ];

  if (techStack) {
    lines.push(`## Tech Stack`, '', techStack, '');
  }

  lines.push(
    `## Documentation Rules`,
    '',
    `NEVER create documentation, design docs, plans, reviews, or markdown files inside the repository tree.`,
    `ALL non-code documentation must go in one of these locations:`,
    '',
    `- \`agent-docs/\` — YOUR private workspace for this task (plans, todos, notes, reviews)`,
    `- \`shared-docs/\` — shared across all agents (lessons learned, architecture decisions)`,
    '',
    `These are symlinked to a persistent store outside the repo. They survive clone refreshes and are visible to the orchestrator.`,
    `Code comments and inline docs in source files are fine — this rule is about standalone documentation files.`,
    '',
  );

  return lines.join('\n');
}

function buildGreenfieldPrompt(
  projectName: string,
  description: string,
  techStack: string,
  agentCount: number,
): string {
  const p = `-p ${projectName}`;
  const techLine = techStack
    ? techStack
    : 'Not specified — recommend one based on the project description.';

  return `You are the orchestrator of a GREENFIELD agent-pool with ${agentCount} active agents for project '${projectName}'.

This is a brand new project — there is no existing codebase. Your job is to bootstrap it.

## Project Vision

${description}

## Tech Stack

${techLine}

## Your Mission

Analyze the project description above.

If the description is clear enough to start building:
1. Break the project into exactly ${agentCount} initial tasks that can be worked on in parallel
2. Task 1 should handle project scaffolding (package.json/pyproject.toml, directory structure, build config, linting)
3. Tasks 2-${agentCount} should be independent feature foundations that build on the scaffold
4. Use --depends-on to make tasks 2-${agentCount} depend on task 1 (the scaffold)
5. Each task prompt must be completely self-contained — agents have zero shared context
6. Include exact file paths, directory structure expectations, and verification steps
7. Every task must end with: commit, push branch, create PR via \`gh pr create\`, run /finish
8. Present your task breakdown to the user for confirmation, then dispatch all ${agentCount} tasks

If the description is too vague to start building:
1. Ask the user 3-5 clarifying questions to refine the requirements
2. Once you have enough information, break it into ${agentCount} tasks and dispatch

IMPORTANT: You MUST use the agent-pool CLI for all task operations. Never guess file paths or read JSON files directly.
IMPORTANT: Always pass ${p} to scope commands to this project.

Key commands:
  agent-pool ${p} tasks                    — Check task queue (pending, in_progress, completed, blocked)
  agent-pool ${p} add "detailed prompt"    — Dispatch a task to an agent
  agent-pool ${p} add --priority 5 "..."   — Higher priority (claimed first)
  agent-pool ${p} add --depends-on t-1 "." — Task depends on another
  agent-pool ${p} status                   — Check clone/agent status
  agent-pool ${p} unblock <id>             — Re-queue a blocked task

Run /dispatch for the full orchestrator protocol with prompt-writing guidelines.`;
}
