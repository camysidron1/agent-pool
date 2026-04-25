#!/usr/bin/env bun
// Standalone CLI entry point for the agent runner
// Usage: bun v2/src/runner/cli.ts <index> --project <name> [--env <name>] [--skip-permissions] [--agent <type>]

import { parseArgs } from 'util';
import { createProductionContext } from '../container.js';
import { AgentRunner } from './runner.js';
import { resolveAgentType, createAdapter } from '../adapters/factory.js';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    project: { type: 'string' },
    env: { type: 'string' },
    'skip-permissions': { type: 'boolean', default: false },
    agent: { type: 'string' },
  },
  allowPositionals: true,
  strict: true,
});

const index = parseInt(positionals[0], 10);
if (isNaN(index)) {
  console.error('Usage: runner-cli <index> --project <name> [--agent <type>]');
  process.exit(1);
}

const dataDir = process.env.AGENT_POOL_DATA_DIR || `${process.env.HOME}/.agent-pool/data`;
const toolDir = process.env.AGENT_POOL_TOOL_DIR || `${process.env.HOME}/.agent-pool`;

const ctx = createProductionContext({ dataDir, toolDir });

const project = values.project
  ? ctx.stores.projects.get(values.project)
  : ctx.stores.projects.getDefault();

if (!project) {
  console.error(values.project ? `Project '${values.project}' not found` : 'No default project set');
  process.exit(1);
}

const agentType = resolveAgentType(values.agent, project.agentType);
const adapter = createAdapter(agentType, ctx.git, { taskStore: ctx.stores.tasks });

const runner = new AgentRunner(ctx, adapter, {
  cloneIndex: index,
  projectName: project.name,
  envName: values.env,
  skipPermissions: !!values['skip-permissions'],
});

await runner.start();
