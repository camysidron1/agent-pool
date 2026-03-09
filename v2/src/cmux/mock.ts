import type { CmuxClient, CmuxPane } from './interfaces.js';

interface CmuxCall {
  method: string;
  args: unknown[];
}

export class MockCmuxClient implements CmuxClient {
  calls: CmuxCall[] = [];
  workspaces: string[] = [];
  panes: CmuxPane[] = [];

  async listWorkspaces(): Promise<string[]> {
    this.calls.push({ method: 'listWorkspaces', args: [] });
    return [...this.workspaces];
  }

  async createWorkspace(name: string): Promise<void> {
    this.calls.push({ method: 'createWorkspace', args: [name] });
    this.workspaces.push(name);
  }

  async deleteWorkspace(name: string): Promise<void> {
    this.calls.push({ method: 'deleteWorkspace', args: [name] });
    this.workspaces = this.workspaces.filter(w => w !== name);
  }

  async listPanes(workspace: string): Promise<CmuxPane[]> {
    this.calls.push({ method: 'listPanes', args: [workspace] });
    return this.panes.filter(p => p.workspace === workspace);
  }

  async createPane(workspace: string, command?: string): Promise<string> {
    this.calls.push({ method: 'createPane', args: [workspace, command] });
    const id = `pane-${this.panes.length}`;
    this.panes.push({ id, name: '', workspace });
    return id;
  }

  async sendKeys(paneId: string, keys: string): Promise<void> {
    this.calls.push({ method: 'sendKeys', args: [paneId, keys] });
  }

  async renamePane(paneId: string, name: string): Promise<void> {
    this.calls.push({ method: 'renamePane', args: [paneId, name] });
    const pane = this.panes.find(p => p.id === paneId);
    if (pane) pane.name = name;
  }

  async newWorkspace(opts: { command?: string }): Promise<{ workspaceRef: string; surfaceRef: string }> {
    this.calls.push({ method: 'newWorkspace', args: [opts] });
    const workspaceRef = `workspace:ws-${this.workspaces.length}`;
    const surfaceRef = `surface:s-${this.panes.length}`;
    this.workspaces.push(workspaceRef);
    this.panes.push({ id: surfaceRef, name: '', workspace: workspaceRef });
    return { workspaceRef, surfaceRef };
  }

  async newSplit(direction: 'right' | 'down', opts: { workspace?: string; surface?: string }): Promise<{ surfaceRef: string }> {
    this.calls.push({ method: 'newSplit', args: [direction, opts] });
    const surfaceRef = `surface:s-${this.panes.length}`;
    const workspace = opts.workspace || this.workspaces[this.workspaces.length - 1] || '';
    this.panes.push({ id: surfaceRef, name: '', workspace });
    return { surfaceRef };
  }

  async send(opts: { workspace?: string; surface?: string }, text: string): Promise<void> {
    this.calls.push({ method: 'send', args: [opts, text] });
  }

  async renameWorkspace(workspaceRef: string, name: string): Promise<void> {
    this.calls.push({ method: 'renameWorkspace', args: [workspaceRef, name] });
  }

  async identifyTab(): Promise<string | null> {
    this.calls.push({ method: 'identifyTab', args: [] });
    return this.workspaces.length > 0 ? this.workspaces[0] : null;
  }

  async identify(): Promise<{ callerSurface: string | null; workspaceRef: string | null }> {
    this.calls.push({ method: 'identify', args: [] });
    const surface = this.panes.length > 0 ? this.panes[0].id : null;
    const workspace = this.workspaces.length > 0 ? this.workspaces[0] : null;
    return { callerSurface: surface, workspaceRef: workspace };
  }

  async closeSurface(surfaceRef: string): Promise<void> {
    this.calls.push({ method: 'closeSurface', args: [surfaceRef] });
    this.panes = this.panes.filter(p => p.id !== surfaceRef);
  }

  async listPaneSurfaces(_workspaceRef?: string): Promise<string[]> {
    this.calls.push({ method: 'listPaneSurfaces', args: [_workspaceRef] });
    return this.panes.map(p => p.id);
  }
}
