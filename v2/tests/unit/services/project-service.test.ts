import { describe, test, expect, beforeEach } from 'bun:test';
import { ProjectService } from '../../../src/services/project-service.js';
import type { ProjectStore, ProjectInput, Project } from '../../../src/stores/interfaces.js';

class MockProjectStore implements ProjectStore {
  projects: Map<string, Project> = new Map();
  defaultName: string | null = null;

  getAll(): Project[] {
    return [...this.projects.values()];
  }

  get(name: string): Project | null {
    return this.projects.get(name) ?? null;
  }

  getDefault(): Project | null {
    if (!this.defaultName) return null;
    return this.projects.get(this.defaultName) ?? null;
  }

  add(input: ProjectInput): void {
    this.projects.set(input.name, {
      name: input.name,
      source: input.source,
      prefix: input.prefix ?? input.name,
      branch: input.branch ?? 'main',
      setup: input.setup ?? null,
      isDefault: false,
      trackingType: null,
      trackingProjectKey: null,
      trackingLabel: null,
      trackingInstructions: null,
      workflowType: null,
      workflowInstructions: null,
      workflowAutoMerge: null,
      workflowMergeMethod: null,
    });
  }

  remove(name: string): void {
    this.projects.delete(name);
  }

  setDefault(name: string): void {
    this.defaultName = name;
    for (const [key, project] of this.projects) {
      project.isDefault = key === name;
    }
  }

  update(name: string, fields: Partial<Project>): void {
    const project = this.projects.get(name);
    if (project) {
      Object.assign(project, fields);
    }
  }
}

describe('ProjectService', () => {
  let store: MockProjectStore;
  let service: ProjectService;

  beforeEach(() => {
    store = new MockProjectStore();
    service = new ProjectService(store);
  });

  describe('add', () => {
    test('adds a project with valid input', () => {
      service.add({ name: 'myproject', source: '/path/to/repo' });
      expect(store.projects.size).toBe(1);
      expect(store.projects.get('myproject')?.source).toBe('/path/to/repo');
    });

    test('throws if name is empty', () => {
      expect(() => service.add({ name: '', source: '/path' })).toThrow('Project name is required');
    });

    test('throws if name is whitespace', () => {
      expect(() => service.add({ name: '  ', source: '/path' })).toThrow('Project name is required');
    });

    test('throws if source is empty', () => {
      expect(() => service.add({ name: 'proj', source: '' })).toThrow('Project source is required');
    });

    test('throws if source is whitespace', () => {
      expect(() => service.add({ name: 'proj', source: '   ' })).toThrow('Project source is required');
    });
  });

  describe('remove', () => {
    test('removes an existing project', () => {
      service.add({ name: 'proj', source: '/src' });
      service.remove('proj');
      expect(store.projects.size).toBe(0);
    });
  });

  describe('list', () => {
    test('returns all projects', () => {
      service.add({ name: 'a', source: '/a' });
      service.add({ name: 'b', source: '/b' });
      expect(service.list()).toHaveLength(2);
    });

    test('returns empty array when no projects', () => {
      expect(service.list()).toEqual([]);
    });
  });

  describe('get', () => {
    test('returns project by name', () => {
      service.add({ name: 'proj', source: '/src' });
      const p = service.get('proj');
      expect(p?.name).toBe('proj');
    });

    test('returns null for unknown project', () => {
      expect(service.get('nope')).toBeNull();
    });
  });

  describe('setDefault', () => {
    test('sets project as default', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setDefault('proj');
      expect(store.defaultName).toBe('proj');
    });

    test('throws if project does not exist', () => {
      expect(() => service.setDefault('ghost')).toThrow("Project 'ghost' not found");
    });
  });

  describe('resolve', () => {
    test('resolves by explicit name', () => {
      service.add({ name: 'proj', source: '/src' });
      const p = service.resolve('proj');
      expect(p.name).toBe('proj');
    });

    test('throws if explicit name not found', () => {
      expect(() => service.resolve('nope')).toThrow("Project 'nope' not found");
    });

    test('resolves default when no name given', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setDefault('proj');
      const p = service.resolve();
      expect(p.name).toBe('proj');
    });

    test('throws when no name given and no default set', () => {
      expect(() => service.resolve()).toThrow('No default project set');
    });
  });

  describe('setTracking', () => {
    test('sets tracking fields on a project', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setTracking('proj', { type: 'linear', projectKey: 'PROJ', label: 'agent', instructions: 'do stuff' });
      const p = store.projects.get('proj')!;
      expect(p.trackingType).toBe('linear');
      expect(p.trackingProjectKey).toBe('PROJ');
      expect(p.trackingLabel).toBe('agent');
      expect(p.trackingInstructions).toBe('do stuff');
    });

    test('sets optional fields to null when omitted', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setTracking('proj', { type: 'linear', projectKey: 'PROJ' });
      const p = store.projects.get('proj')!;
      expect(p.trackingLabel).toBeNull();
      expect(p.trackingInstructions).toBeNull();
    });

    test('throws if project not found', () => {
      expect(() => service.setTracking('nope', { type: 'linear', projectKey: 'X' })).toThrow("Project 'nope' not found");
    });
  });

  describe('clearTracking', () => {
    test('clears all tracking fields', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setTracking('proj', { type: 'linear', projectKey: 'PROJ', label: 'lbl' });
      service.clearTracking('proj');
      const p = store.projects.get('proj')!;
      expect(p.trackingType).toBeNull();
      expect(p.trackingProjectKey).toBeNull();
      expect(p.trackingLabel).toBeNull();
      expect(p.trackingInstructions).toBeNull();
    });
  });

  describe('setWorkflow', () => {
    test('sets workflow fields on a project', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setWorkflow('proj', { type: 'pr', instructions: 'review', autoMerge: true, mergeMethod: 'squash' });
      const p = store.projects.get('proj')!;
      expect(p.workflowType).toBe('pr');
      expect(p.workflowInstructions).toBe('review');
      expect(p.workflowAutoMerge).toBe(true);
      expect(p.workflowMergeMethod).toBe('squash');
    });

    test('sets optional fields to null when omitted', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setWorkflow('proj', { type: 'pr' });
      const p = store.projects.get('proj')!;
      expect(p.workflowInstructions).toBeNull();
      expect(p.workflowAutoMerge).toBeNull();
      expect(p.workflowMergeMethod).toBeNull();
    });

    test('throws if project not found', () => {
      expect(() => service.setWorkflow('nope', { type: 'pr' })).toThrow("Project 'nope' not found");
    });
  });

  describe('clearWorkflow', () => {
    test('clears all workflow fields', () => {
      service.add({ name: 'proj', source: '/src' });
      service.setWorkflow('proj', { type: 'pr', autoMerge: true });
      service.clearWorkflow('proj');
      const p = store.projects.get('proj')!;
      expect(p.workflowType).toBeNull();
      expect(p.workflowInstructions).toBeNull();
      expect(p.workflowAutoMerge).toBeNull();
      expect(p.workflowMergeMethod).toBeNull();
    });
  });
});
