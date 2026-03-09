import type { ProjectStore, ProjectInput, Project } from '../stores/interfaces.js';

export class ProjectService {
  constructor(private store: ProjectStore) {}

  add(input: ProjectInput): void {
    if (!input.name || !input.name.trim()) {
      throw new Error('Project name is required');
    }
    if (!input.source || !input.source.trim()) {
      throw new Error('Project source is required');
    }
    this.store.add(input);
  }

  remove(name: string): void {
    this.store.remove(name);
  }

  list(): Project[] {
    return this.store.getAll();
  }

  get(name: string): Project | null {
    return this.store.get(name);
  }

  setDefault(name: string): void {
    const project = this.store.get(name);
    if (!project) {
      throw new Error(`Project '${name}' not found`);
    }
    this.store.setDefault(name);
  }

  resolve(projectName?: string): Project {
    if (projectName) {
      const project = this.store.get(projectName);
      if (!project) {
        throw new Error(`Project '${projectName}' not found`);
      }
      return project;
    }
    const defaultProject = this.store.getDefault();
    if (!defaultProject) {
      throw new Error('No default project set');
    }
    return defaultProject;
  }

  setTracking(name: string, opts: { type: string; projectKey: string; label?: string; instructions?: string }): void {
    const project = this.store.get(name);
    if (!project) {
      throw new Error(`Project '${name}' not found`);
    }
    this.store.update(name, {
      trackingType: opts.type,
      trackingProjectKey: opts.projectKey,
      trackingLabel: opts.label ?? null,
      trackingInstructions: opts.instructions ?? null,
    });
  }

  clearTracking(name: string): void {
    this.store.update(name, {
      trackingType: null,
      trackingProjectKey: null,
      trackingLabel: null,
      trackingInstructions: null,
    });
  }

  setWorkflow(name: string, opts: { type: string; instructions?: string; autoMerge?: boolean; mergeMethod?: string }): void {
    const project = this.store.get(name);
    if (!project) {
      throw new Error(`Project '${name}' not found`);
    }
    this.store.update(name, {
      workflowType: opts.type,
      workflowInstructions: opts.instructions ?? null,
      workflowAutoMerge: opts.autoMerge ?? null,
      workflowMergeMethod: opts.mergeMethod ?? null,
    });
  }

  clearWorkflow(name: string): void {
    this.store.update(name, {
      workflowType: null,
      workflowInstructions: null,
      workflowAutoMerge: null,
      workflowMergeMethod: null,
    });
  }
}
