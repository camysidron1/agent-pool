// Adapter factory — creates the right AgentAdapter for a given agent type

import type { AgentAdapter } from './agent.js';
import type { GitClient } from '../git/interfaces.js';
import type { TaskStore } from '../stores/interfaces.js';
import { ClaudeAdapter } from './claude.js';
import { CodexAdapter } from './codex.js';
import { PiAdapter } from './pi/index.js';

export type AgentType = 'claude' | 'codex' | 'pi';

/** Optional dependencies for adapters that need more than GitClient. */
export interface AdapterDeps {
  taskStore?: TaskStore;
}

const VALID_TYPES: Set<string> = new Set(['claude', 'codex', 'pi']);

/** Create an adapter instance for the given agent type. */
export function createAdapter(type: AgentType, git: GitClient, deps?: AdapterDeps): AgentAdapter {
  switch (type) {
    case 'claude':
      return new ClaudeAdapter(git);
    case 'codex':
      return new CodexAdapter(git);
    case 'pi':
      if (!deps?.taskStore) {
        throw new Error("PiAdapter requires 'taskStore' in adapter deps");
      }
      return new PiAdapter(git, deps.taskStore);
  }
}

/**
 * Resolve the agent type from CLI flag and project default.
 * CLI flag takes precedence over project default. Defaults to 'claude'.
 * Throws on unknown type.
 */
export function resolveAgentType(cliFlag?: string, projectDefault?: string | null): AgentType {
  const raw = cliFlag ?? projectDefault ?? 'claude';
  if (!VALID_TYPES.has(raw)) {
    throw new Error(`Unknown agent type: '${raw}'. Valid types: ${[...VALID_TYPES].join(', ')}`);
  }
  return raw as AgentType;
}
