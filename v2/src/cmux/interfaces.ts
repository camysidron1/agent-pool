export interface CmuxClient {
  listWorkspaces(): Promise<string[]>;
  createWorkspace(name: string): Promise<void>;
  deleteWorkspace(name: string): Promise<void>;
  listPanes(workspace: string): Promise<CmuxPane[]>;
  createPane(workspace: string, command?: string): Promise<string>;
  sendKeys(paneId: string, keys: string): Promise<void>;
  renamePane(paneId: string, name: string): Promise<void>;
  newWorkspace(opts: { command?: string }): Promise<{ workspaceRef: string; surfaceRef: string }>;
  newSplit(direction: 'right' | 'down', opts: { workspace?: string; surface?: string }): Promise<{ surfaceRef: string }>;
  send(opts: { workspace?: string; surface?: string }, text: string): Promise<void>;
  renameWorkspace(workspaceRef: string, name: string): Promise<void>;
  identifyTab(): Promise<string | null>;
  identify(): Promise<{ callerSurface: string | null; workspaceRef: string | null }>;
  closeSurface(surfaceRef: string): Promise<void>;
  listPaneSurfaces(workspaceRef?: string): Promise<string[]>;
}

export interface CmuxPane {
  id: string;
  name: string;
  workspace: string;
}
