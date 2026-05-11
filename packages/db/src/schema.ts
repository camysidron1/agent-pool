import { sql } from "drizzle-orm";
import { foreignKey, index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

export const projectStatusValues = ["active", "archived"] as const;
export type ProjectStatus = (typeof projectStatusValues)[number];

export const taskStatusValues = ["queued", "running", "blocked", "completed", "failed"] as const;
export type DbTaskStatus = (typeof taskStatusValues)[number];

export const sessionStatusValues = ["queued", "starting", "running", "succeeded", "failed", "canceled"] as const;
export type SessionStatus = (typeof sessionStatusValues)[number];

export const sessionSnapshotKindValues = ["manual", "retry_base", "system"] as const;
export type SessionSnapshotKind = (typeof sessionSnapshotKindValues)[number];

export const orchestratorCommandTypeValues = [
  "start",
  "stop",
  "cancel",
  "retry",
  "cleanup",
  "interrupt",
  "steer",
] as const;
export type OrchestratorCommandType = (typeof orchestratorCommandTypeValues)[number];

export const orchestratorCommandStatusValues = ["queued", "running", "succeeded", "failed", "canceled"] as const;
export type OrchestratorCommandStatus = (typeof orchestratorCommandStatusValues)[number];

export const artifactKindValues = ["final_response_url", "document", "log", "file", "link"] as const;
export type ArtifactKind = (typeof artifactKindValues)[number];

export const outboxStatusValues = ["queued", "published", "failed"] as const;
export type OutboxStatus = (typeof outboxStatusValues)[number];

export const chatMessageRoleValues = ["operator", "assistant", "system"] as const;
export type ChatMessageRole = (typeof chatMessageRoleValues)[number];

export const steeringMessageStatusValues = ["queued", "delivered", "failed", "canceled"] as const;
export type SteeringMessageStatus = (typeof steeringMessageStatusValues)[number];

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

export const sessions = sqliteTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id").notNull(),
    attemptNumber: integer("attempt_number").notNull(),
    status: text("status", { enum: sessionStatusValues }).notNull().default("queued"),
    runtimeProvider: text("runtime_provider"),
    runtimeSessionId: text("runtime_session_id"),
    createdAt: text("created_at").notNull().default(timestampNow),
    startedAt: text("started_at"),
    endedAt: text("ended_at"),
  },
  (table) => [
    uniqueIndex("sessions_project_task_attempt_unique").on(table.projectId, table.taskId, table.attemptNumber),
    uniqueIndex("sessions_project_id_unique").on(table.projectId, table.id),
    index("sessions_project_status_idx").on(table.projectId, table.status),
    foreignKey({
      name: "sessions_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export const sessionSnapshots = sqliteTable(
  "session_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    sessionId: text("session_id").notNull(),
    kind: text("kind", { enum: sessionSnapshotKindValues }).notNull().default("system"),
    providerSnapshotId: text("provider_snapshot_id"),
    label: text("label"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(timestampNow),
  },
  (table) => [
    index("session_snapshots_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "session_snapshots_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export const orchestratorCommands = sqliteTable(
  "orchestrator_commands",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    type: text("type", { enum: orchestratorCommandTypeValues }).notNull(),
    status: text("status", { enum: orchestratorCommandStatusValues }).notNull().default("queued"),
    payloadJson: text("payload_json").notNull().default("{}"),
    errorMessage: text("error_message"),
    requestedBy: text("requested_by"),
    createdAt: text("created_at").notNull().default(timestampNow),
    claimedAt: text("claimed_at"),
    completedAt: text("completed_at"),
  },
  (table) => [
    uniqueIndex("orchestrator_commands_project_id_unique").on(table.projectId, table.id),
    index("orchestrator_commands_project_status_idx").on(table.projectId, table.status),
    index("orchestrator_commands_project_type_idx").on(table.projectId, table.type),
    index("orchestrator_commands_task_idx").on(table.projectId, table.taskId),
    index("orchestrator_commands_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "orchestrator_commands_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "orchestrator_commands_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export const artifacts = sqliteTable(
  "artifacts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    kind: text("kind", { enum: artifactKindValues }).notNull(),
    uri: text("uri").notNull(),
    title: text("title"),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(timestampNow),
  },
  (table) => [
    index("artifacts_project_kind_idx").on(table.projectId, table.kind),
    index("artifacts_task_idx").on(table.projectId, table.taskId),
    index("artifacts_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "artifacts_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "artifacts_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export const events = sqliteTable(
  "events",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    commandId: text("command_id"),
    type: text("type").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(timestampNow),
  },
  (table) => [
    uniqueIndex("events_project_id_unique").on(table.projectId, table.id),
    index("events_project_created_idx").on(table.projectId, table.createdAt),
    index("events_type_idx").on(table.projectId, table.type),
    index("events_task_idx").on(table.projectId, table.taskId),
    index("events_session_idx").on(table.projectId, table.sessionId),
    index("events_command_idx").on(table.projectId, table.commandId),
    foreignKey({
      name: "events_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "events_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "events_command_fk",
      columns: [table.projectId, table.commandId],
      foreignColumns: [orchestratorCommands.projectId, orchestratorCommands.id],
    }).onDelete("set null").onUpdate("cascade"),
  ],
);

export const outbox = sqliteTable(
  "outbox",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    eventId: text("event_id"),
    status: text("status", { enum: outboxStatusValues }).notNull().default("queued"),
    routingKey: text("routing_key").notNull(),
    payloadJson: text("payload_json").notNull().default("{}"),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: text("created_at").notNull().default(timestampNow),
    publishedAt: text("published_at"),
  },
  (table) => [
    index("outbox_status_created_idx").on(table.status, table.createdAt),
    index("outbox_project_status_idx").on(table.projectId, table.status),
    foreignKey({
      name: "outbox_event_fk",
      columns: [table.projectId, table.eventId],
      foreignColumns: [events.projectId, events.id],
    }).onDelete("set null").onUpdate("cascade"),
  ],
);

export const chatMessages = sqliteTable(
  "chat_messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    role: text("role", { enum: chatMessageRoleValues }).notNull(),
    body: text("body").notNull(),
    metadataJson: text("metadata_json").notNull().default("{}"),
    createdAt: text("created_at").notNull().default(timestampNow),
  },
  (table) => [
    index("chat_messages_project_created_idx").on(table.projectId, table.createdAt),
    index("chat_messages_task_idx").on(table.projectId, table.taskId),
    index("chat_messages_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "chat_messages_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "chat_messages_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export const steeringMessages = sqliteTable(
  "steering_messages",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    commandId: text("command_id"),
    body: text("body").notNull(),
    status: text("status", { enum: steeringMessageStatusValues }).notNull().default("queued"),
    errorMessage: text("error_message"),
    createdAt: text("created_at").notNull().default(timestampNow),
    deliveredAt: text("delivered_at"),
  },
  (table) => [
    index("steering_messages_project_status_idx").on(table.projectId, table.status),
    index("steering_messages_task_idx").on(table.projectId, table.taskId),
    index("steering_messages_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "steering_messages_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "steering_messages_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "steering_messages_command_fk",
      columns: [table.projectId, table.commandId],
      foreignColumns: [orchestratorCommands.projectId, orchestratorCommands.id],
    }).onDelete("set null").onUpdate("cascade"),
  ],
);

export const notes = sqliteTable(
  "notes",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade", onUpdate: "cascade" }),
    taskId: text("task_id"),
    sessionId: text("session_id"),
    authorId: text("author_id"),
    body: text("body").notNull(),
    createdAt: text("created_at").notNull().default(timestampNow),
    updatedAt: text("updated_at").notNull().default(timestampNow),
  },
  (table) => [
    index("notes_project_created_idx").on(table.projectId, table.createdAt),
    index("notes_task_idx").on(table.projectId, table.taskId),
    index("notes_session_idx").on(table.projectId, table.sessionId),
    foreignKey({
      name: "notes_task_fk",
      columns: [table.projectId, table.taskId],
      foreignColumns: [tasks.projectId, tasks.id],
    }).onDelete("cascade").onUpdate("cascade"),
    foreignKey({
      name: "notes_session_fk",
      columns: [table.projectId, table.sessionId],
      foreignColumns: [sessions.projectId, sessions.id],
    }).onDelete("cascade").onUpdate("cascade"),
  ],
);

export type ProjectRow = typeof projects.$inferSelect;
export type NewProjectRow = typeof projects.$inferInsert;
export type TaskRow = typeof tasks.$inferSelect;
export type NewTaskRow = typeof tasks.$inferInsert;
export type TaskDependencyRow = typeof taskDependencies.$inferSelect;
export type NewTaskDependencyRow = typeof taskDependencies.$inferInsert;
export type SessionRow = typeof sessions.$inferSelect;
export type NewSessionRow = typeof sessions.$inferInsert;
export type SessionSnapshotRow = typeof sessionSnapshots.$inferSelect;
export type NewSessionSnapshotRow = typeof sessionSnapshots.$inferInsert;
export type OrchestratorCommandRow = typeof orchestratorCommands.$inferSelect;
export type NewOrchestratorCommandRow = typeof orchestratorCommands.$inferInsert;
export type ArtifactRow = typeof artifacts.$inferSelect;
export type NewArtifactRow = typeof artifacts.$inferInsert;
export type EventRow = typeof events.$inferSelect;
export type NewEventRow = typeof events.$inferInsert;
export type OutboxRow = typeof outbox.$inferSelect;
export type NewOutboxRow = typeof outbox.$inferInsert;
export type ChatMessageRow = typeof chatMessages.$inferSelect;
export type NewChatMessageRow = typeof chatMessages.$inferInsert;
export type SteeringMessageRow = typeof steeringMessages.$inferSelect;
export type NewSteeringMessageRow = typeof steeringMessages.$inferInsert;
export type NoteRow = typeof notes.$inferSelect;
export type NewNoteRow = typeof notes.$inferInsert;
