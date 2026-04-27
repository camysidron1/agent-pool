// Shared utility for building runner shell commands

import type { Project } from '../stores/interfaces.js';

export interface RunnerCommandOpts {
  env?: string;
  skipPermissions?: boolean;
  queue?: boolean;
  agent?: string;
  push?: boolean;
  workspaceRef?: string;
}

export function buildRunnerCommand(
  clonePath: string,
  index: number,
  project: Project,
  toolDir: string,
  opts: RunnerCommandOpts,
): string {
  if (opts.queue === false) {
    // No queue — run agent directly
    if (opts.agent === 'codex') {
      return `cd ${clonePath} && codex exec --full-auto`;
    }
    const flags = opts.skipPermissions ? ' --dangerously-skip-permissions' : '';
    return `cd ${clonePath} && claude${flags}`;
  }
  const envFlag = opts.env ? ` --env ${opts.env}` : '';
  const skipFlag = opts.skipPermissions ? ' --skip-permissions' : '';
  const agentFlag = opts.agent ? ` --agent ${opts.agent}` : '';
  const pushFlag = opts.push === false ? '' : ' --push';
  const wsFlag = opts.workspaceRef ? ` --workspace-ref ${opts.workspaceRef}` : '';
  return `cd ${clonePath} && agent-pool -p ${project.name} run-agent ${index}${skipFlag}${envFlag}${agentFlag}${pushFlag}${wsFlag}`;
}
