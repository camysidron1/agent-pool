import type { CmuxClient, CmuxPane } from './interfaces.js';

const CMUX_TIMEOUT_MS = 10_000;

async function run(args: string[]): Promise<string> {
  const proc = Bun.spawn(args, {
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const timeout = new Promise<never>((_, reject) =>
    setTimeout(() => {
      proc.kill('SIGKILL');
      reject(new Error(`cmux command timed out after ${CMUX_TIMEOUT_MS}ms: ${args.join(' ')}`));
    }, CMUX_TIMEOUT_MS),
  );

  const result = Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  const [stdout, stderr, exitCode] = await Promise.race([result, timeout]);
  if (exitCode !== 0) {
    throw new Error(`cmux command failed (exit ${exitCode}): ${args.join(' ')}\n${stderr}`);
  }
  return stdout.trim();
}

async function runJson<T>(args: string[]): Promise<T> {
  const output = await run([...args, '--json']);
  return JSON.parse(output) as T;
}

export class RealCmuxClient implements CmuxClient {
  async listWorkspaces(): Promise<string[]> {
    try {
      const output = await run(['cmux', 'list-workspaces', '--json']);
      const data = JSON.parse(output);
      if (Array.isArray(data)) {
        return data.map((w: { ref?: string; name?: string }) => w.ref || w.name || '');
      }
      return [];
    } catch {
      return [];
    }
  }

  async createWorkspace(name: string): Promise<void> {
    await run(['cmux', 'new-workspace', '--name', name]);
  }

  async deleteWorkspace(name: string): Promise<void> {
    await run(['cmux', 'close-workspace', '--workspace', name]);
  }

  async listPanes(workspace: string): Promise<CmuxPane[]> {
    try {
      const output = await run(['cmux', 'list-surfaces', '--workspace', workspace, '--json']);
      const data = JSON.parse(output);
      if (Array.isArray(data)) {
        return data.map((p: { ref?: string; name?: string }) => ({
          id: p.ref || '',
          name: p.name || '',
          workspace,
        }));
      }
      return [];
    } catch {
      return [];
    }
  }

  async createPane(workspace: string, command?: string): Promise<string> {
    const args = ['cmux', 'new-split', 'right', '--workspace', workspace];
    if (command) args.push('--command', command);
    const output = await run(args);
    try {
      const data = JSON.parse(output);
      return data.surfaceRef || '';
    } catch {
      const surfaceMatch = output.match(/surface:\S+/);
      return surfaceMatch ? surfaceMatch[0] : '';
    }
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    await run(['cmux', 'send', '--surface', paneId, '--', keys]);
  }

  async renamePane(paneId: string, name: string): Promise<void> {
    await run(['cmux', 'rename-surface', '--surface', paneId, '--name', name]);
  }

  async newWorkspace(opts: { command?: string }): Promise<{ workspaceRef: string; surfaceRef: string }> {
    const args = ['cmux', 'new-workspace'];
    if (opts.command) args.push('--command', opts.command);
    const output = await run(args);
    // cmux may return JSON or plain text like "OK <uuid>" or "OK workspace:<ref> surface:<ref>"
    try {
      const data = JSON.parse(output);
      return { workspaceRef: data.workspaceRef, surfaceRef: data.surfaceRef };
    } catch {
      // Parse plain text: "OK <workspace-ref>" or "OK workspace:<ref> surface:<ref>"
      const parts = output.split(/\s+/).filter(p => p !== 'OK');
      const workspaceMatch = parts.find(p => p.startsWith('workspace:')) || parts[0] || '';
      const surfaceMatch = parts.find(p => p.startsWith('surface:')) || '';
      return { workspaceRef: workspaceMatch, surfaceRef: surfaceMatch };
    }
  }

  async newSplit(direction: 'right' | 'down', opts: { workspace?: string; surface?: string }): Promise<{ surfaceRef: string }> {
    const args = ['cmux', 'new-split', direction];
    if (opts.workspace) args.push('--workspace', opts.workspace);
    if (opts.surface) args.push('--surface', opts.surface);
    const output = await run(args);
    // cmux may return JSON or plain text like "OK surface:123 workspace:456"
    try {
      const data = JSON.parse(output);
      return { surfaceRef: data.surfaceRef };
    } catch {
      // Parse plain text format: "OK surface:<ref> workspace:<ref>"
      const surfaceMatch = output.match(/surface:\S+/);
      return { surfaceRef: surfaceMatch ? surfaceMatch[0] : '' };
    }
  }

  async send(opts: { workspace?: string; surface?: string }, text: string): Promise<void> {
    const args = ['cmux', 'send'];
    if (opts.workspace) args.push('--workspace', opts.workspace);
    if (opts.surface) args.push('--surface', opts.surface);
    args.push('--', text + '\\n');
    await run(args);
  }

  async renameWorkspace(workspaceRef: string, name: string): Promise<void> {
    await run(['cmux', 'rename-workspace', '--workspace', workspaceRef, '--name', name]);
  }

  async identifyTab(): Promise<string | null> {
    try {
      const output = await run(['cmux', 'identify-tab', '--json']);
      const data = JSON.parse(output);
      return data.workspaceRef || data.ref || null;
    } catch {
      return null;
    }
  }

  async identify(): Promise<{ callerSurface: string | null; workspaceRef: string | null }> {
    try {
      const output = await run(['cmux', 'identify', '--json']);
      const data = JSON.parse(output);
      const caller = data.caller || data.focused || {};
      return {
        callerSurface: caller.surface_ref || caller.surfaceRef || null,
        workspaceRef: caller.workspace_ref || caller.workspaceRef || null,
      };
    } catch {
      return { callerSurface: null, workspaceRef: null };
    }
  }

  async closeSurface(surfaceRef: string): Promise<void> {
    try {
      await run(['cmux', 'close-surface', '--surface', surfaceRef]);
    } catch {
      // Surface may already be closed
    }
  }

  async listPaneSurfaces(workspaceRef?: string): Promise<string[]> {
    try {
      const args = ['cmux', 'list-panes', '--json'];
      if (workspaceRef) args.splice(2, 0, '--workspace', workspaceRef);
      const output = await run(args);
      const data = JSON.parse(output);
      const surfaces: string[] = [];
      for (const pane of data.panes || []) {
        for (const s of pane.surface_refs || pane.surfaceRefs || []) {
          surfaces.push(s);
        }
      }
      return surfaces;
    } catch {
      return [];
    }
  }
}
