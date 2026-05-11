import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projectStatusValues = ["active", "archived"] as const;
export type ProjectStatus = (typeof projectStatusValues)[number];

export const taskStatusValues = ["queued", "running", "blocked", "completed", "failed"] as const;
export type DbTaskStatus = (typeof taskStatusValues)[number];

const timestampNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

export const projects = sqliteTable(
  "projects",
  {
    id: text("id").primaryKey(),
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    description: text("description"),
    status: text("status", { enum: projectStatusValues }).notNull().default("active"),
    taskDisplaySequence: integer("task_display_sequence").notNull().default(0),
    createdAt: text("created_at").notNull().default(timestampNow),
    updatedAt: text("updated_at").notNull().default(timestampNow),
  },
  (table) => [uniqueIndex("projects_slug_unique").on(table.slug)],
);

export const tasks = sqliteTable(
  "tasks",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    displayId: integer("display_id").notNull(),
    title: text("title").notNull(),
    description: text("description"),
    status: text("status", { enum: taskStatusValues }).notNull().default("queued"),
    createdAt: text("created_at").notNull().default(timestampNow),
    updatedAt: text("updated_at").notNull().default(timestampNow),
  },
  (table) => [
    uniqueIndex("tasks_project_display_id_unique").on(table.projectId, table.displayId),
    uniqueIndex("tasks_project_id_unique").on(table.projectId, table.id),
    index("tasks_project_status_idx").on(table.projectId, table.status),
  ],
);

export const taskDependencies = sqliteTable(
  "task_dependencies",
  {
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id").notNull(),
    dependsOnTaskId: text("depends_on_task_id").notNull(),
    createdAt: text("created_at").notNull().default(timestampNow),
  },
  (table) => [
    uniqueIndex("task_dependencies_unique").on(table.projectId, table.taskId, table.dependsOnTaskId),
    index("task_dependencies_depends_on_idx").on(table.projectId, table.dependsOnTaskId),
    foreignKey({
      name: "task_dependencies_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "task_dependencies_depends_on_fk",
      columns: [table.projectId, table.dependsOnTaskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type NewTaskDependencyRow = typeof taskDependencies.$inferInsert;
