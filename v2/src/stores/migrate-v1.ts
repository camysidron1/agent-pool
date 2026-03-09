import { Database } from 'bun:sqlite';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

export interface MigrationResult {
  projects: number;
  clones: number;
  tasks: number;
  dependencies: number;
  errors: string[];
}

interface V1ProjectsFile {
  default?: string;
  projects: Record<string, {
    source: string;
    prefix: string;
    branch: string;
    setup?: string | null;
    tracking?: {
      type?: string;
      project_key?: string;
      label?: string;
      instructions?: string;
    } | null;
    git_workflow?: {
      type?: string;
      instructions?: string;
      auto_merge?: boolean;
      merge_method?: string;
    } | null;
  }>;
}

interface V1Clone {
  index: number;
  locked: boolean;
  workspace_id?: string;
  locked_at?: string;
  branch: string;
}

interface V1Task {
  id: string;
  prompt: string;
  status: string;
  claimed_by?: string | null;
  created_at: string;
  started_at?: string | null;
  completed_at?: string | null;
  depends_on?: string[];
}

function readJsonFile<T>(path: string): T | null {
  if (!existsSync(path)) return null;
  const raw = readFileSync(path, 'utf-8');
  return JSON.parse(raw) as T;
}

/**
 * Migrate v1 JSON data files into the SQLite database.
 * Reads projects.json, pool-*.json, tasks-*.json from dataDir.
 * Uses raw SQL (not store classes) for self-contained operation.
 */
export function migrateFromV1(db: Database, dataDir: string): MigrationResult {
  const result: MigrationResult = {
    projects: 0,
    clones: 0,
    tasks: 0,
    dependencies: 0,
    errors: [],
  };

  // 1. Read projects.json
  const projectsPath = join(dataDir, 'projects.json');
  const projectsData = readJsonFile<V1ProjectsFile>(projectsPath);
  if (!projectsData) {
    result.errors.push('projects.json not found or unreadable');
    return result;
  }

  const defaultProject = projectsData.default ?? null;
  const projects = projectsData.projects ?? {};

  // Collect all task IDs first for dependency validation
  const allTaskIds = new Set<string>();
  for (const projectName of Object.keys(projects)) {
    const tasksData = readJsonFile<{ tasks: V1Task[] }>(join(dataDir, `tasks-${projectName}.json`));
    if (tasksData?.tasks) {
      for (const task of tasksData.tasks) {
        allTaskIds.add(task.id);
      }
    }
  }

  // Wrap in transaction for atomicity
  const transaction = db.transaction(() => {
    // 2. Insert projects
    const insertProject = db.prepare(`
      INSERT INTO projects (
        name, source, prefix, branch, setup, is_default,
        tracking_type, tracking_project_key, tracking_label, tracking_instructions,
        workflow_type, workflow_instructions, workflow_auto_merge, workflow_merge_method
      ) VALUES (
        $name, $source, $prefix, $branch, $setup, $is_default,
        $tracking_type, $tracking_project_key, $tracking_label, $tracking_instructions,
        $workflow_type, $workflow_instructions, $workflow_auto_merge, $workflow_merge_method
      )
    `);

    const insertClone = db.prepare(`
      INSERT INTO clones (project_name, clone_index, locked, workspace_id, locked_at, branch)
      VALUES ($project_name, $clone_index, $locked, $workspace_id, $locked_at, $branch)
    `);

    const insertTask = db.prepare(`
      INSERT INTO tasks (id, project_name, prompt, status, claimed_by, created_at, started_at, completed_at)
      VALUES ($id, $project_name, $prompt, $status, $claimed_by, $created_at, $started_at, $completed_at)
    `);

    const insertDep = db.prepare(`
      INSERT INTO task_dependencies (task_id, depends_on) VALUES ($task_id, $depends_on)
    `);

    for (const [projectName, proj] of Object.entries(projects)) {
      // Insert project
      try {
        const tracking = proj.tracking ?? null;
        const workflow = proj.git_workflow ?? null;

        insertProject.run({
          $name: projectName,
          $source: proj.source,
          $prefix: proj.prefix ?? projectName,
          $branch: proj.branch ?? 'main',
          $setup: proj.setup ?? null,
          $is_default: projectName === defaultProject ? 1 : 0,
          $tracking_type: tracking?.type ?? null,
          $tracking_project_key: tracking?.project_key ?? null,
          $tracking_label: tracking?.label ?? null,
          $tracking_instructions: tracking?.instructions ?? null,
          $workflow_type: workflow?.type ?? null,
          $workflow_instructions: workflow?.instructions ?? null,
          $workflow_auto_merge: workflow?.auto_merge != null ? (workflow.auto_merge ? 1 : 0) : null,
          $workflow_merge_method: workflow?.merge_method ?? null,
        });
        result.projects++;
      } catch (err: any) {
        if (err.message?.includes('UNIQUE constraint')) {
          result.errors.push(`Duplicate project: ${projectName}`);
          continue;
        }
        throw err;
      }

      // 3. Read and insert clones
      const poolData = readJsonFile<{ clones: V1Clone[] }>(join(dataDir, `pool-${projectName}.json`));
      if (poolData?.clones) {
        for (const clone of poolData.clones) {
          try {
            insertClone.run({
              $project_name: projectName,
              $clone_index: clone.index,
              $locked: clone.locked ? 1 : 0,
              $workspace_id: clone.workspace_id || '',
              $locked_at: clone.locked_at || null,
              $branch: clone.branch ?? proj.branch ?? 'main',
            });
            result.clones++;
          } catch (err: any) {
            if (err.message?.includes('UNIQUE constraint')) {
              result.errors.push(`Duplicate clone: ${projectName}[${clone.index}]`);
            } else {
              throw err;
            }
          }
        }
      }

      // 4. Read and insert tasks
      const tasksData = readJsonFile<{ tasks: V1Task[] }>(join(dataDir, `tasks-${projectName}.json`));
      if (tasksData?.tasks) {
        for (const task of tasksData.tasks) {
          try {
            insertTask.run({
              $id: task.id,
              $project_name: projectName,
              $prompt: task.prompt,
              $status: task.status ?? 'pending',
              $claimed_by: task.claimed_by ?? null,
              $created_at: task.created_at,
              $started_at: task.started_at ?? null,
              $completed_at: task.completed_at ?? null,
            });
            result.tasks++;
          } catch (err: any) {
            if (err.message?.includes('UNIQUE constraint')) {
              result.errors.push(`Duplicate task: ${task.id}`);
              continue;
            }
            throw err;
          }

          // Insert dependencies
          if (task.depends_on?.length) {
            for (const dep of task.depends_on) {
              if (!allTaskIds.has(dep)) {
                result.errors.push(`Task ${task.id} depends on unknown task ${dep}`);
                continue;
              }
              try {
                insertDep.run({ $task_id: task.id, $depends_on: dep });
                result.dependencies++;
              } catch (err: any) {
                if (err.message?.includes('UNIQUE constraint')) {
                  result.errors.push(`Duplicate dependency: ${task.id} → ${dep}`);
                } else {
                  throw err;
                }
              }
            }
          }
        }
      }
    }
  });

  transaction();
  return result;
}
