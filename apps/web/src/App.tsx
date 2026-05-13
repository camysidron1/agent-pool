import {
  useEffect,
  useMemo,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import { createPublicApiClient, PublicApiError, type PublicProjectSummary, type PublicTaskDetail, type PublicTaskSummary } from "./api";
import {
  clearStoredOperatorId,
  normalizeOperatorId,
  readStoredOperatorId,
  saveStoredOperatorId,
  type BrowserStorage,
} from "./auth";
import {
  chooseSelectedProjectId,
  applyTaskColumn,
  applyTaskPriority,
  BOARD_COLUMNS,
  findTask,
  getPriorityLabel,
  getSupportedMoveAction,
  groupTasksByColumn,
  PRIORITY_OPTIONS,
  readStoredSelectedProjectId,
  replaceTask,
  saveStoredSelectedProjectId,
  selectActiveSession,
  summarizeLogStream,
  type BoardColumnId,
} from "./board";
import { shouldRefreshBoardForEvent, subscribeProjectEvents } from "./sse";

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
  const [draggedTaskId, setDraggedTaskId] = useState<string | null>(null);
  const [dropTargetColumn, setDropTargetColumn] = useState<string | null>(null);
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [taskDetail, setTaskDetail] = useState<PublicTaskDetail | null>(null);
  const [taskDetailLoadState, setTaskDetailLoadState] = useState<LoadState>("idle");
  const [taskDetailError, setTaskDetailError] = useState<string | null>(null);
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

  useEffect(() => {
    if (!api || !selectedProjectId || !operatorId) return;
    let cancelled = false;

    async function refreshTasksFromEvent(): Promise<void> {
      if (!api || !selectedProjectId || cancelled) return;

      try {
        const response = await api.listTasks(selectedProjectId);
        if (!cancelled) setTasks(response.tasks);
      } catch (error) {
        if (!cancelled) setTaskMutationError(formatApiError(error));
      }
    }

    const unsubscribe = subscribeProjectEvents({
      baseUrl: apiBaseUrl,
      operatorId,
      projectId: selectedProjectId,
      onEvent: (event) => {
        if (shouldRefreshBoardForEvent(event, selectedProjectId)) {
          void refreshTasksFromEvent();
        }
      },
      onFallbackRefresh: () => void refreshTasksFromEvent(),
      onError: () => {
        if (!cancelled) setTaskMutationError("Live updates are refreshing periodically.");
      },
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [api, apiBaseUrl, operatorId, selectedProjectId]);

  useEffect(() => {
    if (!api || !selectedProjectId || !selectedTaskId) {
      setTaskDetail(null);
      setTaskDetailLoadState("idle");
      setTaskDetailError(null);
      return;
    }

    let cancelled = false;
    setTaskDetailLoadState("loading");
    setTaskDetailError(null);

    api
      .readTask(selectedProjectId, selectedTaskId)
      .then((response) => {
        if (cancelled) return;
        setTaskDetail(response.task);
        setTaskDetailLoadState("ready");
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setTaskDetail(null);
        setTaskDetailError(formatApiError(error));
        setTaskDetailLoadState("error");
      });

    return () => {
      cancelled = true;
    };
  }, [api, selectedProjectId, selectedTaskId]);

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
    setSelectedTaskId(null);
    setTaskDetail(null);
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

  function beginTaskDrag(task: PublicTaskSummary, event: DragEvent<HTMLElement>): void {
    setDraggedTaskId(task.id);
    event.dataTransfer.effectAllowed = "move";
    event.dataTransfer.setData("text/plain", task.id);
  }

  function endTaskDrag(): void {
    setDraggedTaskId(null);
    setDropTargetColumn(null);
  }

  function dragOverColumn(columnId: string, event: DragEvent<HTMLElement>): void {
    if (!draggedTaskId) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "move";
    setDropTargetColumn(columnId);
  }

  async function dropTaskOnColumn(columnId: string, event: DragEvent<HTMLElement>): Promise<void> {
    event.preventDefault();
    const taskId = event.dataTransfer.getData("text/plain") || draggedTaskId;
    endTaskDrag();
    if (!taskId || !isBoardColumnId(columnId)) return;

    const task = findTask(tasks, taskId);
    if (!task) return;

    await moveTask(task, columnId);
  }

  async function moveTask(task: PublicTaskSummary, targetColumn: BoardColumnId): Promise<void> {
    if (!api || !selectedProjectId) return;
    const action = getSupportedMoveAction(task, targetColumn);
    if (!action) {
      setTaskMutationError("That Kanban move is not available for this task state.");
      return;
    }

    const previousTasks = tasks;
    setTaskMutationError(null);
    setTasks((current) => applyTaskColumn(current, { taskId: task.id, targetColumn }));

    try {
      if (action === "unblock") {
        const response = await api.unblockTask(selectedProjectId, task.id);
        setTasks((current) => replaceTask(current, response.task));
        return;
      }

      await api.backlogTask(selectedProjectId, task.id);
      const response = await api.updateTaskPriority(selectedProjectId, task.id, -50);
      setTasks((current) => replaceTask(current, response.task));
    } catch (error) {
      setTasks(previousTasks);
      setTaskMutationError(formatApiError(error));
    }
  }

  function openTaskPanel(taskId: string): void {
    setSelectedTaskId(taskId);
  }

  function closeTaskPanel(): void {
    setSelectedTaskId(null);
    setTaskDetail(null);
    setTaskDetailLoadState("idle");
    setTaskDetailError(null);
  }

  function openTaskPanelFromKeyboard(taskId: string, event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openTaskPanel(taskId);
  }

  function stopCardActionPropagation(event: MouseEvent<HTMLElement>): void {
    event.stopPropagation();
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
                  <section
                    key={column.id}
                    className={`kanban-column ${dropTargetColumn === column.id ? "kanban-column-drop" : ""}`}
                    aria-label={column.title}
                    onDragOver={(event: DragEvent<HTMLElement>) => dragOverColumn(column.id, event)}
                    onDragLeave={() => setDropTargetColumn(null)}
                    onDrop={(event: DragEvent<HTMLElement>) => void dropTaskOnColumn(column.id, event)}
                  >
                    <header className="kanban-column-header">
                      <h3>{column.title}</h3>
                      <span>{groupedTasks[column.id].length}</span>
                    </header>
                    <div className="kanban-card-list">
                      {groupedTasks[column.id].length === 0 ? <p className="column-empty">No tasks</p> : null}
                      {groupedTasks[column.id].map((task) => (
                        <article
                          key={task.id}
                          className="task-card"
                          draggable
                          tabIndex={0}
                          role="button"
                          aria-label={`Open ${task.title}`}
                          onClick={() => openTaskPanel(task.id)}
                          onKeyDown={(event: KeyboardEvent<HTMLElement>) => openTaskPanelFromKeyboard(task.id, event)}
                          onDragStart={(event: DragEvent<HTMLElement>) => beginTaskDrag(task, event)}
                          onDragEnd={endTaskDrag}
                        >
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
                          <div className="task-card-footer" onClick={stopCardActionPropagation}>
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
      {selectedTaskId ? (
        <TaskPanel
          detail={taskDetail}
          loadState={taskDetailLoadState}
          error={taskDetailError}
          onClose={closeTaskPanel}
        />
      ) : null}
    </main>
  );
}

type LoadState = "idle" | "loading" | "ready" | "error";

function isBoardColumnId(value: string): value is BoardColumnId {
  return BOARD_COLUMNS.some((column) => column.id === value);
}

function BoardNotice({ title, body, tone = "neutral" }: { readonly title: string; readonly body: string; readonly tone?: "neutral" | "error" }) {
  return (
    <div className={`board-notice board-notice-${tone}`}>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  );
}

function TaskPanel({
  detail,
  loadState,
  error,
  onClose,
}: {
  readonly detail: PublicTaskDetail | null;
  readonly loadState: LoadState;
  readonly error: string | null;
  readonly onClose: () => void;
}) {
  const activeSession = detail ? selectActiveSession(detail) : null;

  return (
    <aside className="task-panel" aria-label="Task detail">
      <header className="task-panel-header">
        <div>
          <p className="eyebrow">Task detail</p>
          <h2>{detail?.title ?? "Loading task"}</h2>
        </div>
        <button type="button" onClick={onClose} aria-label="Close task detail">
          Close
        </button>
      </header>

      {loadState === "loading" ? <BoardNotice title="Loading task" body="Fetching task detail from the public API." /> : null}
      {loadState === "error" ? <BoardNotice title="Task detail failed" body={error ?? "Unable to load task detail."} tone="error" /> : null}
      {loadState === "ready" && detail ? (
        <div className="task-panel-body">
          <section className="panel-section" aria-label="Task summary">
            <dl className="detail-grid">
              <div>
                <dt>Status</dt>
                <dd>{detail.status}</dd>
              </div>
              <div>
                <dt>Priority</dt>
                <dd>{getPriorityLabel(detail.priority)}</dd>
              </div>
              <div>
                <dt>Updated</dt>
                <dd>{formatTimestamp(detail.updatedAt)}</dd>
              </div>
            </dl>
            {detail.description ? <p>{detail.description}</p> : null}
          </section>

          <section className="panel-section" aria-label="Active session">
            <h3>Active Session</h3>
            {activeSession ? (
              <dl className="detail-grid">
                <div>
                  <dt>Attempt</dt>
                  <dd>{activeSession.attemptNumber}</dd>
                </div>
                <div>
                  <dt>Status</dt>
                  <dd>{activeSession.status}</dd>
                </div>
                <div>
                  <dt>Provider</dt>
                  <dd>{activeSession.runtimeProvider ?? "none"}</dd>
                </div>
              </dl>
            ) : (
              <p>No active session.</p>
            )}
          </section>

          <section className="panel-section" aria-label="Raw logs">
            <h3>Raw Logs</h3>
            {detail.logStreams.length === 0 ? (
              <p>No logs recorded.</p>
            ) : (
              <ul className="log-list">
                {detail.logStreams.map((logStream) => (
                  <li key={logStream.id}>
                    <span>{summarizeLogStream(logStream)}</span>
                    <time>{formatTimestamp(logStream.updatedAt)}</time>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="panel-section" aria-label="Steering">
            <h3>Steering</h3>
            <textarea disabled rows={4} value="" aria-label="Steering message" />
            <button type="button" disabled>
              Send
            </button>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function formatApiError(error: unknown): string {
  if (error instanceof PublicApiError) {
    return error.message;
  }

  return error instanceof Error ? error.message : "Unexpected public API error.";
}

function formatTimestamp(value: string | null): string {
  if (!value) return "none";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;

  return date.toLocaleString();
}

function readBrowserStorage(): BrowserStorage | null {
  return typeof window === "undefined" ? null : window.localStorage;
}
