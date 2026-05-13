import { useEffect, useMemo, useState, type ChangeEvent, type FormEvent } from "react";

import { createPublicApiClient, PublicApiError, type PublicProjectSummary, type PublicTaskSummary } from "./api";
import {
  clearStoredOperatorId,
  normalizeOperatorId,
  readStoredOperatorId,
  saveStoredOperatorId,
  type BrowserStorage,
} from "./auth";
import {
  chooseSelectedProjectId,
  applyTaskPriority,
  BOARD_COLUMNS,
  getPriorityLabel,
  groupTasksByColumn,
  PRIORITY_OPTIONS,
  readStoredSelectedProjectId,
  replaceTask,
  saveStoredSelectedProjectId,
} from "./board";

export type AppProps = {
  readonly apiBaseUrl?: string;
  readonly storage?: BrowserStorage | null;
};

export function App({ apiBaseUrl, storage = readBrowserStorage() }: AppProps) {
  const initialOperatorId = readStoredOperatorId(storage) ?? "";
  const [operatorId, setOperatorId] = useState(initialOperatorId);
  const [operatorDraft, setOperatorDraft] = useState(initialOperatorId);
  const [authError, setAuthError] = useState<string | null>(null);
  const [projects, setProjects] = useState<readonly PublicProjectSummary[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(() => readStoredSelectedProjectId(storage));
  const [projectLoadState, setProjectLoadState] = useState<LoadState>("idle");
  const [projectError, setProjectError] = useState<string | null>(null);
  const [tasks, setTasks] = useState<readonly PublicTaskSummary[]>([]);
  const [taskLoadState, setTaskLoadState] = useState<LoadState>("idle");
  const [taskError, setTaskError] = useState<string | null>(null);
  const [taskMutationError, setTaskMutationError] = useState<string | null>(null);
  const [priorityMutations, setPriorityMutations] = useState<ReadonlySet<string>>(() => new Set());
  const isAuthenticated = operatorId.length > 0;
  const api = useMemo(
    () => (isAuthenticated ? createPublicApiClient({ baseUrl: apiBaseUrl, operatorId }) : null),
    [apiBaseUrl, isAuthenticated, operatorId],
  );
  const selectedProject = projects.find((project) => project.id === selectedProjectId) ?? null;
  const groupedTasks = useMemo(() => groupTasksByColumn(tasks), [tasks]);

  useEffect(() => {
    if (!api) {
      setProjects([]);
      setSelectedProjectId(null);
      setProjectLoadState("idle");
      setProjectError(null);
      return;
    }

    let cancelled = false;
    setProjectLoadState("loading");
    setProjectError(null);

    api
      .listProjects()
      .then((response) => {
        if (cancelled) return;
        const nextProjectId = chooseSelectedProjectId(response.projects, selectedProjectId, readStoredSelectedProjectId(storage));

        setProjects(response.projects);
        setSelectedProjectId(nextProjectId);
        saveStoredSelectedProjectId(storage, nextProjectId);
        setProjectLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setProjects([]);
        setSelectedProjectId(null);
        setProjectError(formatApiError(error));
        setProjectLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [api, storage]);

  useEffect(() => {
    if (!api || !selectedProjectId) {
      setTasks([]);
      setTaskLoadState("idle");
      setTaskError(null);
      return;
    }

    let cancelled = false;
    setTaskLoadState("loading");
    setTaskError(null);

    api
      .listTasks(selectedProjectId)
      .then((response) => {
        if (cancelled) return;
        setTasks(response.tasks);
        setTaskMutationError(null);
        setTaskLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTasks([]);
        setTaskError(formatApiError(error));
        setTaskLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedProjectId]);

  function submitOperator(event: FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const normalized = normalizeOperatorId(operatorDraft);

    if (!normalized) {
      setAuthError("Operator id is required.");
      return;
    }

    saveStoredOperatorId(storage, normalized);
    setOperatorId(normalized);
    setOperatorDraft(normalized);
    setAuthError(null);
  }

  function signOut(): void {
    clearStoredOperatorId(storage);
    saveStoredSelectedProjectId(storage, null);
    setOperatorId("");
    setOperatorDraft("");
    setAuthError(null);
    setProjects([]);
    setTasks([]);
    setSelectedProjectId(null);
    setProjectLoadState("idle");
    setTaskLoadState("idle");
  }

  function updateOperatorDraft(event: ChangeEvent<HTMLInputElement>): void {
    setOperatorDraft(event.currentTarget.value);
  }

  function selectProject(event: ChangeEvent<HTMLSelectElement>): void {
    const nextProjectId = event.currentTarget.value || null;
    setSelectedProjectId(nextProjectId);
    saveStoredSelectedProjectId(storage, nextProjectId);
    setTaskMutationError(null);
  }

  async function updatePriority(task: PublicTaskSummary, event: ChangeEvent<HTMLSelectElement>): Promise<void> {
    if (!api || !selectedProjectId) return;
    const priority = Number(event.currentTarget.value);
    const previousTasks = tasks;

    setTaskMutationError(null);
    setPriorityMutations((current) => new Set(current).add(task.id));
    setTasks((current) => applyTaskPriority(current, { taskId: task.id, priority }));

    try {
      const response = await api.updateTaskPriority(selectedProjectId, task.id, priority);
      setTasks((current) => replaceTask(current, response.task));
    } catch (error) {
      setTasks(previousTasks);
      setTaskMutationError(formatApiError(error));
    } finally {
      setPriorityMutations((current) => {
        const next = new Set(current);
        next.delete(task.id);
        return next;
      });
    }
  }

  if (!isAuthenticated) {
    return (
      <main className="app-shell auth-shell" aria-labelledby="auth-title">
        <section className="auth-panel">
          <p className="eyebrow">Agent Pool</p>
          <h1 id="auth-title">Operator sign in</h1>
          <form className="auth-form" onSubmit={submitOperator}>
            <label htmlFor="operator-id">Operator id</label>
            <div className="auth-row">
              <input
                id="operator-id"
                name="operator-id"
                autoComplete="username"
                value={operatorDraft}
                onChange={updateOperatorDraft}
              />
              <button type="submit">Continue</button>
            </div>
            {authError ? <p className="form-error">{authError}</p> : null}
          </form>
        </section>
      </main>
    );
  }

  return (
    <main className="app-shell" data-api-ready={api ? "true" : "false"}>
      <header className="topbar">
        <div>
          <p className="eyebrow">Agent Pool</p>
          <h1>Project board</h1>
        </div>
        <div className="operator-menu">
          <span>{operatorId}</span>
          <button type="button" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <section className="workspace-band" aria-label="Project board">
        <div className="board-toolbar">
          <label htmlFor="project-selector">Project</label>
          <select
            id="project-selector"
            value={selectedProjectId ?? ""}
            onChange={selectProject}
            disabled={projectLoadState === "loading" || projects.length === 0}
          >
            {projects.length === 0 ? <option value="">No projects</option> : null}
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
          {selectedProject ? <span className="project-status">{selectedProject.status}</span> : null}
        </div>

        {projectLoadState === "loading" ? <BoardNotice title="Loading projects" body="Fetching project list from the public API." /> : null}
        {projectLoadState === "error" ? <BoardNotice title="Project load failed" body={projectError ?? "Unable to load projects."} tone="error" /> : null}
        {projectLoadState === "ready" && projects.length === 0 ? (
          <BoardNotice title="No projects" body="Create a project through the backend API to populate this board." />
        ) : null}
        {projectLoadState === "ready" && selectedProject ? (
          <section className="project-board-preview" aria-label={`${selectedProject.name} tasks`}>
            <div className="project-summary">
              <div>
                <h2>{selectedProject.name}</h2>
                {selectedProject.description ? <p>{selectedProject.description}</p> : null}
              </div>
              <dl className="task-counts" aria-label="Task counts">
                {Object.entries(selectedProject.taskCounts).map(([status, count]) => (
                  <div key={status}>
                    <dt>{status}</dt>
                    <dd>{count}</dd>
                  </div>
                ))}
              </dl>
            </div>

            {taskLoadState === "loading" ? <BoardNotice title="Loading tasks" body="Fetching selected project tasks." /> : null}
            {taskLoadState === "error" ? <BoardNotice title="Task load failed" body={taskError ?? "Unable to load tasks."} tone="error" /> : null}
            {taskMutationError ? <p className="inline-error">{taskMutationError}</p> : null}
            {taskLoadState === "ready" && tasks.length === 0 ? (
              <BoardNotice title="No tasks" body="This selected project has no tasks yet." />
            ) : null}
            {taskLoadState === "ready" && tasks.length > 0 ? (
              <div className="kanban-board" aria-label="Loaded project Kanban board">
                {BOARD_COLUMNS.map((column) => (
                  <section key={column.id} className="kanban-column" aria-label={column.title}>
                    <header className="kanban-column-header">
                      <h3>{column.title}</h3>
                      <span>{groupedTasks[column.id].length}</span>
                    </header>
                    <div className="kanban-card-list">
                      {groupedTasks[column.id].length === 0 ? <p className="column-empty">No tasks</p> : null}
                      {groupedTasks[column.id].map((task) => (
                        <article key={task.id} className="task-card">
                          <div className="task-card-title">
                            <strong>{task.title}</strong>
                            <span>{task.status}</span>
                          </div>
                          {task.description ? <p>{task.description}</p> : null}
                          {task.runtimeSource ? (
                            <p className="runtime-source">
                              {task.runtimeSource.repositoryUrl} @ {task.runtimeSource.baseRef}
                            </p>
                          ) : null}
                          <div className="task-card-footer">
                            <label>
                              <span>Priority</span>
                              <select
                                value={task.priority}
                                onChange={(event: ChangeEvent<HTMLSelectElement>) => void updatePriority(task, event)}
                                disabled={priorityMutations.has(task.id)}
                              >
                                {PRIORITY_OPTIONS.map((option) => (
                                  <option key={option.value} value={option.value}>
                                    {option.label}
                                  </option>
                                ))}
                                {PRIORITY_OPTIONS.every((option) => option.value !== task.priority) ? (
                                  <option value={task.priority}>{getPriorityLabel(task.priority)}</option>
                                ) : null}
                              </select>
                            </label>
                            {task.pendingCommands.length > 0 ? (
                              <span className="pending-command">{task.pendingCommands.length} pending</span>
                            ) : null}
                          </div>
                        </article>
                      ))}
                    </div>
                  </section>
                ))}
              </div>
            ) : null}
          </section>
        ) : null}
      </section>
    </main>
  );
}

type LoadState = "idle" | "loading" | "ready" | "error";

function BoardNotice({ title, body, tone = "neutral" }: { readonly title: string; readonly body: string; readonly tone?: "neutral" | "error" }) {
  return (
    <div className={`board-notice board-notice-${tone}`}>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function formatApiError(error: unknown): string {
  if (error instanceof PublicApiError) {
    return error.message;
  }

  return error instanceof Error ? error.message : "Unexpected public API error.";
}

function readBrowserStorage(): BrowserStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
