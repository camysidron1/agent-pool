import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type DragEvent,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
} from "react";

import {
  createPublicApiClient,
  PublicApiError,
  type PublicProjectSummary,
  type PublicSessionSummary,
  type PublicTaskDetail,
  type PublicTaskSummary,
} from "./api";
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
  getTaskResultSummary,
  getSupportedMoveAction,
  groupTasksByColumn,
  PRIORITY_OPTIONS,
  readStoredSelectedProjectId,
  replaceTask,
  saveStoredSelectedProjectId,
  selectActiveSession,
  type BoardColumnId,
} from "./board";
import { shouldRefreshBoardForEvent, subscribeProjectEvents } from "./sse";
import {
  buildSteeringInterruptPayload,
  cancelInterruptConfirmation,
  getSteeringAvailability,
  getSteeringInterruptAvailability,
  getVisibleSteeringMessages,
  shouldUseIncomingTaskDetail,
  startInterruptConfirmation,
  submitSteeringDraft,
  type InterruptConfirmationState,
} from "./steering";
import { formatRawLogEntries, getRawLogEntries, shouldFollowRawLogScroll, summarizeLogFallback, type RawLogEntry } from "./task-detail";

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
  const [taskDetailMode, setTaskDetailMode] = useState<TaskDetailMode>("panel");
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
        if (selectedTaskId) {
          const detailResponse = await api.readTask(selectedProjectId, selectedTaskId);
          if (!cancelled) setTaskDetail((current) => (shouldUseIncomingTaskDetail(current, detailResponse.task) ? detailResponse.task : current));
        }
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
  }, [api, apiBaseUrl, operatorId, selectedProjectId, selectedTaskId]);

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
        setTaskDetail((current) => (shouldUseIncomingTaskDetail(current, response.task) ? response.task : current));
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
    setTaskDetailMode("panel");
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
    setTaskDetailMode("panel");
  }

  function closeTaskPanel(): void {
    setSelectedTaskId(null);
    setTaskDetail(null);
    setTaskDetailLoadState("idle");
    setTaskDetailError(null);
    setTaskDetailMode("panel");
  }

  function openTaskPanelFromKeyboard(taskId: string, event: KeyboardEvent<HTMLElement>): void {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    openTaskPanel(taskId);
  }

  function stopCardActionPropagation(event: MouseEvent<HTMLElement>): void {
    event.stopPropagation();
  }

  async function submitTaskSteering(input: {
    readonly detail: PublicTaskDetail;
    readonly activeSession: PublicSessionSummary | null;
    readonly body: string;
    readonly files: readonly File[];
  }): Promise<void> {
    if (!api || !selectedProjectId) {
      throw new Error("Public API is unavailable.");
    }

    const response = await submitSteeringDraft({
      api,
      projectId: selectedProjectId,
      task: input.detail,
      activeSession: input.activeSession,
      body: input.body,
      files: input.files,
    });

    const updatedTask = response.task;
    if (updatedTask) {
      setTaskDetail((current) => (shouldUseIncomingTaskDetail(current, updatedTask) ? updatedTask : current));
      setTasks((current) => replaceTask(current, updatedTask));
    }
  }

  async function interruptTaskSteering(input: {
    readonly detail: PublicTaskDetail;
    readonly activeSession: PublicSessionSummary | null;
  }): Promise<void> {
    if (!api || !selectedProjectId) {
      throw new Error("Public API is unavailable.");
    }
    if (!input.activeSession) {
      throw new Error("No active session is available.");
    }

    const response = await api.interruptSession(
      selectedProjectId,
      input.detail.id,
      input.activeSession.id,
      buildSteeringInterruptPayload(input.detail),
    );
    const updatedTask = response.task;
    if (updatedTask) {
      setTaskDetail((current) => (shouldUseIncomingTaskDetail(current, updatedTask) ? updatedTask : current));
      setTasks((current) => replaceTask(current, updatedTask));
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
          mode={taskDetailMode}
          onExpand={() => setTaskDetailMode("full")}
          onCollapse={() => setTaskDetailMode("panel")}
          onClose={closeTaskPanel}
          onSubmitSteering={submitTaskSteering}
          onInterruptSteering={interruptTaskSteering}
        />
      ) : null}
    </main>
  );
}

type LoadState = "idle" | "loading" | "ready" | "error";
type TaskDetailMode = "panel" | "full";

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
  mode,
  onExpand,
  onCollapse,
  onClose,
  onSubmitSteering,
  onInterruptSteering,
}: {
  readonly detail: PublicTaskDetail | null;
  readonly loadState: LoadState;
  readonly error: string | null;
  readonly mode: TaskDetailMode;
  readonly onExpand: () => void;
  readonly onCollapse: () => void;
  readonly onClose: () => void;
  readonly onSubmitSteering: (input: {
    readonly detail: PublicTaskDetail;
    readonly activeSession: PublicSessionSummary | null;
    readonly body: string;
    readonly files: readonly File[];
  }) => Promise<void>;
  readonly onInterruptSteering: (input: { readonly detail: PublicTaskDetail; readonly activeSession: PublicSessionSummary | null }) => Promise<void>;
}) {
  const [steeringDraft, setSteeringDraft] = useState("");
  const [steeringFiles, setSteeringFiles] = useState<readonly File[]>([]);
  const [steeringInputKey, setSteeringInputKey] = useState(0);
  const [steeringSubmitState, setSteeringSubmitState] = useState<"idle" | "submitting">("idle");
  const [steeringError, setSteeringError] = useState<string | null>(null);
  const [steeringNotice, setSteeringNotice] = useState<string | null>(null);
  const [interruptConfirmation, setInterruptConfirmation] = useState<InterruptConfirmationState>("idle");
  const [interruptSubmitState, setInterruptSubmitState] = useState<"idle" | "submitting">("idle");
  const [interruptError, setInterruptError] = useState<string | null>(null);
  const activeSession = detail ? selectActiveSession(detail) : null;
  const resultSummary = detail ? getTaskResultSummary(detail) : null;
  const steeringAvailability = getSteeringAvailability(detail, activeSession);
  const visibleSteeringMessages = detail ? getVisibleSteeringMessages(detail) : [];
  const interruptAvailability = getSteeringInterruptAvailability(detail, activeSession);
  const steeringDisabled = !steeringAvailability.available || steeringSubmitState === "submitting";
  const canSubmitSteering = steeringAvailability.available && steeringDraft.trim().length > 0 && steeringSubmitState !== "submitting";
  const panelLabel = mode === "full" ? "Full-page task detail" : "Task detail";

  useEffect(() => {
    setSteeringDraft("");
    setSteeringFiles([]);
    setSteeringInputKey((current) => current + 1);
    setSteeringError(null);
    setSteeringNotice(null);
    setInterruptConfirmation("idle");
    setInterruptError(null);
  }, [detail?.id]);

  function updateSteeringDraft(event: ChangeEvent<HTMLTextAreaElement>): void {
    setSteeringDraft(event.currentTarget.value);
    setSteeringNotice(null);
    setSteeringError(null);
  }

  function selectSteeringFiles(event: ChangeEvent<HTMLInputElement>): void {
    setSteeringFiles(Array.from(event.currentTarget.files ?? []));
    setSteeringNotice(null);
    setSteeringError(null);
  }

  async function submitSteering(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (!detail) return;

    setSteeringSubmitState("submitting");
    setSteeringError(null);
    setSteeringNotice(null);

    try {
      await onSubmitSteering({
        detail,
        activeSession,
        body: steeringDraft,
        files: steeringFiles,
      });
      setSteeringDraft("");
      setSteeringFiles([]);
      setSteeringInputKey((current) => current + 1);
      setSteeringNotice("Steering queued.");
    } catch (submitError) {
      setSteeringError(formatApiError(submitError));
    } finally {
      setSteeringSubmitState("idle");
    }
  }

  async function submitInterrupt(): Promise<void> {
    if (!detail) return;

    setInterruptSubmitState("submitting");
    setInterruptError(null);
    setSteeringNotice(null);

    try {
      await onInterruptSteering({ detail, activeSession });
      setInterruptConfirmation("idle");
      setSteeringNotice("Interrupt queued.");
    } catch (submitError) {
      setInterruptError(formatApiError(submitError));
    } finally {
      setInterruptSubmitState("idle");
    }
  }

  return (
    <aside className={`task-panel task-panel-${mode}`} aria-label={panelLabel}>
      <header className="task-panel-header">
        <div>
          <p className="eyebrow">Task detail</p>
          <h2>{detail?.title ?? "Loading task"}</h2>
        </div>
        <div className="task-panel-actions">
          {mode === "full" ? (
            <button type="button" className="secondary-button" onClick={onCollapse}>
              Dock
            </button>
          ) : (
            <button type="button" className="secondary-button" onClick={onExpand}>
              Expand
            </button>
          )}
          <button type="button" onClick={onClose} aria-label="Close task detail">
            Close
          </button>
        </div>
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
            <RawLogViewer detail={detail} />
          </section>

          {resultSummary && resultSummary.kind !== "none" ? (
            <section className={`panel-section result-summary result-summary-${resultSummary.kind}`} aria-label="Result summary">
              <h3>{resultSummary.title}</h3>
              <p>{resultSummary.body}</p>
              {resultSummary.finalResponseUrls.length > 0 ? (
                <ul className="artifact-list">
                  {resultSummary.finalResponseUrls.map((url) => (
                    <li key={url}>
                      <a href={url} target="_blank" rel="noreferrer">
                        {url}
                      </a>
                    </li>
                  ))}
                </ul>
              ) : null}
              {resultSummary.latestLogSummary ? <p>{resultSummary.latestLogSummary}</p> : null}
              {resultSummary.commandStates.length > 0 ? (
                <ul className="command-state-list">
                  {resultSummary.commandStates.map((commandState) => (
                    <li key={commandState}>{commandState}</li>
                  ))}
                </ul>
              ) : null}
            </section>
          ) : null}

          <section className="panel-section" aria-label="Steering">
            <h3>Steering</h3>
            {visibleSteeringMessages.length > 0 ? (
              <ul className="steering-message-list" aria-label="Queued and failed steering">
                {visibleSteeringMessages.map((message) => (
                  <li key={message.id} className={`steering-message steering-message-${message.status}`}>
                    <div className="steering-message-header">
                      <strong>{message.displayStatus}</strong>
                      <time>{formatTimestamp(message.deliveredAt ?? message.createdAt)}</time>
                    </div>
                    <p>{message.body}</p>
                    {message.attachments.length > 0 ? (
                      <ul className="attachment-list" aria-label="Steering message attachments">
                        {message.attachments.map((attachment) => (
                          <li key={attachment.key}>
                            <span>{attachment.fileName ?? attachment.key}</span>
                            <small>{attachment.contentType ?? attachment.bucket ?? "planned upload"}</small>
                          </li>
                        ))}
                      </ul>
                    ) : null}
                    {message.errorMessage ? <p className="form-error">{message.errorMessage}</p> : null}
                    {message.status === "failed" ? (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => {
                          setSteeringDraft(message.body);
                          setSteeringError(null);
                          setSteeringNotice(null);
                        }}
                      >
                        Retry
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            ) : null}
            {visibleSteeringMessages.length > 0 ? (
              <div className="interrupt-escalation" aria-label="Steering interrupt escalation">
                {interruptConfirmation === "confirming" ? (
                  <div className="interrupt-confirmation">
                    <p>Confirm interrupt for this active session.</p>
                    <div className="interrupt-actions">
                      <button
                        type="button"
                        disabled={!interruptAvailability.available || interruptSubmitState === "submitting"}
                        onClick={() => void submitInterrupt()}
                      >
                        {interruptSubmitState === "submitting" ? "Interrupting" : "Confirm interrupt"}
                      </button>
                      <button
                        type="button"
                        className="secondary-button"
                        disabled={interruptSubmitState === "submitting"}
                        onClick={() => {
                          setInterruptConfirmation(cancelInterruptConfirmation());
                          setInterruptError(null);
                        }}
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                ) : (
                  <div className="interrupt-actions">
                    <button
                      type="button"
                      className="secondary-button"
                      disabled={!interruptAvailability.available}
                      onClick={() => {
                        setInterruptConfirmation((current) => startInterruptConfirmation(current, interruptAvailability));
                        setInterruptError(null);
                      }}
                    >
                      Interrupt
                    </button>
                    <p className="steering-state">{interruptAvailability.reason ?? "Escalate queued steering."}</p>
                  </div>
                )}
                {interruptError ? <p className="form-error">{interruptError}</p> : null}
              </div>
            ) : null}
            <form className="steering-form" onSubmit={(event: FormEvent<HTMLFormElement>) => void submitSteering(event)}>
              <textarea
                disabled={steeringDisabled}
                rows={4}
                value={steeringDraft}
                onChange={updateSteeringDraft}
                aria-label="Steering message"
              />
              <label className="attachment-control">
                <span>Attachments</span>
                <input
                  key={steeringInputKey}
                  type="file"
                  multiple
                  disabled={steeringDisabled}
                  onChange={selectSteeringFiles}
                  aria-label="Steering attachments"
                />
              </label>
              {steeringFiles.length > 0 ? (
                <ul className="attachment-list" aria-label="Selected steering attachments">
                  {steeringFiles.map((file) => (
                    <li key={`${file.name}:${file.size}:${file.lastModified}`}>
                      <span>{file.name}</span>
                      <small>{file.type || "application/octet-stream"}</small>
                    </li>
                  ))}
                </ul>
              ) : null}
              <div className="steering-actions">
                <p className="steering-state">{steeringAvailability.reason ?? "Ready to steer active session."}</p>
                <button type="submit" disabled={!canSubmitSteering}>
                  {steeringSubmitState === "submitting" ? "Sending" : "Send"}
                </button>
              </div>
              {steeringError ? <p className="form-error">{steeringError}</p> : null}
              {steeringNotice ? <p className="form-success">{steeringNotice}</p> : null}
            </form>
          </section>
        </div>
      ) : null}
    </aside>
  );
}

function RawLogViewer({ detail }: { readonly detail: PublicTaskDetail }) {
  const rawLogs = getRawLogEntries(detail);
  const logText = formatRawLogEntries(rawLogs);
  const fallbackSummaries = summarizeLogFallback(detail.logStreams);
  const outputRef = useRef<HTMLPreElement | null>(null);
  const [followLogs, setFollowLogs] = useState(true);

  useEffect(() => {
    const node = outputRef.current;
    if (!node || !followLogs) return;

    node.scrollTop = node.scrollHeight;
  }, [followLogs, logText]);

  function updateFollowState(): void {
    const node = outputRef.current;
    if (!node) return;

    setFollowLogs(
      shouldFollowRawLogScroll({
        scrollHeight: node.scrollHeight,
        scrollTop: node.scrollTop,
        clientHeight: node.clientHeight,
      }),
    );
  }

  if (rawLogs.length > 0) {
    return (
      <div className="raw-log-shell" data-following-logs={followLogs ? "true" : "false"}>
        <RawLogMeta entries={rawLogs} />
        <pre ref={outputRef} className="raw-log-output" onScroll={updateFollowState} aria-label="Raw output log">
          {logText}
        </pre>
      </div>
    );
  }

  if (fallbackSummaries.length === 0) {
    return <p>No logs recorded.</p>;
  }

  return (
    <ul className="log-list" aria-label="Log stream summaries">
      {detail.logStreams.map((logStream, index) => (
        <li key={logStream.id}>
          <span>{fallbackSummaries[index]}</span>
          <time>{formatTimestamp(logStream.updatedAt)}</time>
        </li>
      ))}
    </ul>
  );
}

function RawLogMeta({ entries }: { readonly entries: readonly RawLogEntry[] }) {
  const first = entries[0];
  const latest = entries.at(-1);
  const streams = Array.from(new Set(entries.map((entry) => entry.stream))).join(", ");

  return (
    <dl className="raw-log-meta" aria-label="Raw log metadata">
      <div>
        <dt>Chunks</dt>
        <dd>{entries.length}</dd>
      </div>
      <div>
        <dt>Streams</dt>
        <dd>{streams}</dd>
      </div>
      <div>
        <dt>Window</dt>
        <dd>
          {formatTimestamp(first?.observedAt ?? first?.createdAt ?? null)} to {formatTimestamp(latest?.observedAt ?? latest?.createdAt ?? null)}
        </dd>
      </div>
    </dl>
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
