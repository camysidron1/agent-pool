import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import {
  createDrizzleDatabase,
  migrateWebSandboxDatabase,
  projects,
  taskDependencies,
  tasks,
  type NewProjectRow,
  type NewTaskRow,
} from "../src";

describe("core project/task schema", () => {
  test("exports Drizzle schema for projects, tasks, and task dependencies", () => {
    expect(projects).toBeDefined();
    expect(tasks).toBeDefined();
    expect(taskDependencies).toBeDefined();

    const project: NewProjectRow = {
      id: "project_1",
      slug: "demo",
      name: "Demo Project",
    };
    const task: NewTaskRow = {
      id: "task_1",
      projectId: project.id,
      displayId: 1,
      title: "Build schema",
    };

    expect(project.status).toBeUndefined();
    expect(task.status).toBeUndefined();
  });

  test("supports project-scoped task display IDs", () => {
    const database = createMigratedMemoryDatabase();

    try {
      database
        .query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
        .run("project_a", "project-a", "Project A");
      database
        .query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
        .run("project_b", "project-b", "Project B");

      database
        .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
        .run("task_a_1", "project_a", 1, "Task A1");
      database
        .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
        .run("task_b_1", "project_b", 1, "Task B1");

      expect(() =>
        database
          .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
          .run("task_a_duplicate", "project_a", 1, "Duplicate display id"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("keeps task dependencies inside one project and prevents duplicates", () => {
    const database = createMigratedMemoryDatabase();

    try {
      database
        .query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
        .run("project_a", "project-a", "Project A");
      database
        .query("INSERT INTO projects (id, slug, name) VALUES (?, ?, ?)")
        .run("project_b", "project-b", "Project B");

      database
        .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
        .run("task_a_1", "project_a", 1, "Task A1");
      database
        .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
        .run("task_a_2", "project_a", 2, "Task A2");
      database
        .query("INSERT INTO tasks (id, project_id, display_id, title) VALUES (?, ?, ?, ?)")
        .run("task_b_1", "project_b", 1, "Task B1");

      database
        .query("INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES (?, ?, ?)")
        .run("project_a", "task_a_2", "task_a_1");

      expect(() =>
        database
          .query("INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES (?, ?, ?)")
          .run("project_a", "task_a_2", "task_a_1"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES (?, ?, ?)")
          .run("project_a", "task_a_1", "task_a_1"),
      ).toThrow();
      expect(() =>
        database
          .query("INSERT INTO task_dependencies (project_id, task_id, depends_on_task_id) VALUES (?, ?, ?)")
          .run("project_a", "task_a_1", "task_b_1"),
      ).toThrow();
    } finally {
      database.close();
    }
  });

  test("schema can be passed to the Drizzle Bun SQLite adapter", () => {
    const database = createMigratedMemoryDatabase();

    try {
      const drizzleDb = createDrizzleDatabase(database);

      expect(drizzleDb).toBeDefined();
    } finally {
      database.close();
    }
  });
});

function createMigratedMemoryDatabase(): Database {
  const database = new Database(":memory:", { strict: true });
  migrateWebSandboxDatabase(database);

  return database;
}
