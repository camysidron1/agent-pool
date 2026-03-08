import { writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';

/**
 * Write sample v1 JSON fixture files to a directory.
 */
export function createV1Fixtures(dir: string, opts?: {
  projectCount?: number;
  tasksPerProject?: number;
  clonesPerProject?: number;
  includeDependencies?: boolean;
  includeTracking?: boolean;
  includeWorkflow?: boolean;
}): void {
  const {
    projectCount = 1,
    tasksPerProject = 2,
    clonesPerProject = 2,
    includeDependencies = false,
    includeTracking = false,
    includeWorkflow = false,
  } = opts ?? {};

  mkdirSync(dir, { recursive: true });

  const projectNames: string[] = [];
  const projects: Record<string, any> = {};

  for (let p = 0; p < projectCount; p++) {
    const name = p === 0 ? 'myproject' : `project-${p}`;
    projectNames.push(name);

    const proj: any = {
      source: `/path/to/${name}`,
      prefix: name.slice(0, 2),
      branch: p === 0 ? 'main' : 'develop',
      setup: p === 0 ? 'bun install' : null,
    };

    if (includeTracking) {
      proj.tracking = {
        type: 'linear',
        project_key: name.toUpperCase().slice(0, 3),
        label: 'bug',
        instructions: 'Link to issue',
      };
    }

    if (includeWorkflow) {
      proj.git_workflow = {
        type: 'pr',
        instructions: 'Use conventional commits',
        auto_merge: true,
        merge_method: 'squash',
      };
    }

    projects[name] = proj;

    // Generate clones
    const clones: any[] = [];
    for (let c = 0; c < clonesPerProject; c++) {
      clones.push({
        index: c,
        locked: c === 0,
        workspace_id: c === 0 ? `workspace:${c}` : '',
        locked_at: c === 0 ? '2025-01-15T10:30:00' : '',
        branch: proj.branch,
      });
    }
    writeFileSync(join(dir, `pool-${name}.json`), JSON.stringify({ clones }, null, 2));

    // Generate tasks
    const tasks: any[] = [];
    for (let t = 0; t < tasksPerProject; t++) {
      const taskId = `t-${name}-${t}`;
      const depends: string[] = [];
      if (includeDependencies && t > 0) {
        depends.push(`t-${name}-${t - 1}`);
      }
      tasks.push({
        id: taskId,
        prompt: `Task ${t} for ${name}`,
        status: t === 0 ? 'completed' : 'pending',
        claimed_by: t === 0 ? 'agent-01' : null,
        created_at: '2025-01-15T10:00:00',
        started_at: t === 0 ? '2025-01-15T10:05:00' : null,
        completed_at: t === 0 ? '2025-01-15T11:00:00' : null,
        depends_on: depends,
      });
    }
    writeFileSync(join(dir, `tasks-${name}.json`), JSON.stringify({ tasks }, null, 2));
  }

  const projectsJson = {
    default: projectNames[0],
    projects,
  };
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(projectsJson, null, 2));
}

/**
 * Write minimal v1 fixtures — just one project, no clones, no tasks.
 */
export function createMinimalV1Fixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });

  const projectsJson = {
    default: 'minimal',
    projects: {
      minimal: {
        source: '/path/to/minimal',
        prefix: 'mn',
        branch: 'main',
        setup: null,
      },
    },
  };
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(projectsJson, null, 2));
}

/**
 * Write v1 fixtures with edge cases — empty arrays, null fields, missing files.
 */
export function createEdgeCaseV1Fixtures(dir: string): void {
  mkdirSync(dir, { recursive: true });

  const projectsJson = {
    default: 'edgecase',
    projects: {
      edgecase: {
        source: '/path/to/edge',
        prefix: 'ec',
        branch: 'main',
        setup: null,
        tracking: null,
        git_workflow: null,
      },
      nofiles: {
        source: '/path/to/nofiles',
        prefix: 'nf',
        branch: 'main',
      },
    },
  };
  writeFileSync(join(dir, 'projects.json'), JSON.stringify(projectsJson, null, 2));

  // edgecase project has empty clone and task arrays
  writeFileSync(join(dir, 'pool-edgecase.json'), JSON.stringify({ clones: [] }, null, 2));
  writeFileSync(join(dir, 'tasks-edgecase.json'), JSON.stringify({ tasks: [] }, null, 2));

  // nofiles project: no pool or tasks file at all — should be gracefully skipped
}
