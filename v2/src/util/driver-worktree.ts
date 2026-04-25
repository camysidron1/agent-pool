import { join } from 'path';

/**
 * Derive a stable, unique short id for a driver instance.
 * Prefers the cmux workspace id (so re-running `start` in the same workspace
 * reuses the same worktree). Falls back to the current pid when run outside
 * cmux — those won't be cleanly reusable across processes, but are still
 * unique-per-run.
 */
export function deriveDriverShortId(workspaceRef: string | undefined): string {
  if (workspaceRef) {
    return workspaceRef.replace(/[^a-zA-Z0-9]/g, '').slice(-8);
  }
  return `pid${process.pid}`;
}

export function driverWorktreePath(
  dataDir: string,
  prefix: string,
  shortId: string,
): string {
  return join(dataDir, `${prefix}-driver-${shortId}`);
}

export function driverBranchName(shortId: string): string {
  return `agent-pool/dispatch-${shortId}`;
}
