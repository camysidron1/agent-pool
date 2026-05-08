import { describe, expect, test } from "bun:test";

import { DEFAULT_PROJECT_TASK_QUEUE, SHARED_PACKAGE_NAME, type ProjectScopedTask } from "../src";

describe("workspace smoke test", () => {
  test("loads shared exports and sees the tiny fixture repo path", async () => {
    const task: ProjectScopedTask = {
      id: "task-smoke",
      projectId: "project-smoke",
      title: "Smoke test task",
      status: "queued",
    };

    expect(SHARED_PACKAGE_NAME).toBe("@agent-pool/shared");
    expect(DEFAULT_PROJECT_TASK_QUEUE).toBe("project-tasks");
    expect(task.status).toBe("queued");
    expect(await Bun.file("test-fixtures/tiny-repo/.gitkeep").exists()).toBe(true);
  });
});
