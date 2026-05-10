import { DEFAULT_PROJECT_TASK_QUEUE, type ProjectScopedTask } from "@agent-pool/shared";

const placeholderTask: ProjectScopedTask = {
  id: "demo-task-001",
  projectId: "demo-project",
  title: "Wire the web MVP shell to the backend API",
  status: "queued",
};

export function App() {
  return (
    <main className="shell">
      <section className="hero" aria-labelledby="agent-pool-title">
        <p className="eyebrow">Agent Pool Web MVP</p>
        <h1 id="agent-pool-title">Project task board shell</h1>
        <p>
          This browser-only shell is ready for the future Kanban board while keeping runtime providers and backend-owned state behind API boundaries.
        </p>
      </section>

      <section className="card" aria-label="Shared package import smoke">
        <h2>Shared contract smoke</h2>
        <dl>
          <div>
            <dt>Task queue</dt>
            <dd>{DEFAULT_PROJECT_TASK_QUEUE}</dd>
          </div>
          <div>
            <dt>Placeholder task</dt>
            <dd>
              {placeholderTask.title} — {placeholderTask.status}
            </dd>
          </div>
        </dl>
      </section>
    </main>
  );
}
