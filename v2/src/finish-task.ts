#!/usr/bin/env bun
/**
 * Marks the current task from inside a Claude session.
 * Uses AGENT_POOL_* env vars set by the runner.
 *
 * Usage: bun run finish-task.ts <status>
 */
import { createProductionContext } from './container.js';
import type { TaskStatus } from './stores/interfaces.js';
import { appendFileSync, mkdirSync } from 'fs';
import { dirname, join } from 'path';

const taskId = process.env.AGENT_POOL_TASK_ID;
const dataDir = process.env.AGENT_POOL_DATA_DIR;
const toolDir = process.env.AGENT_POOL_TOOL_DIR;
const status = process.argv[2] as TaskStatus | undefined;

const validStatuses: TaskStatus[] = [
  'completed',
  'blocked',
  'pending',
  'backlogged',
  'cancelled',
  'review_requested',
];

if (!taskId || !dataDir || !status || !validStatuses.includes(status)) {
  console.error('Usage: finish-task.ts <status>');
  console.error(
    'Requires AGENT_POOL_TASK_ID and AGENT_POOL_DATA_DIR env vars',
  );
  console.error(`Valid statuses: ${validStatuses.join(', ')}`);
  process.exit(1);
}

const ctx = createProductionContext({
  dataDir,
  toolDir: toolDir || dataDir,
});

ctx.stores.tasks.mark(taskId, status);
const eventType = status === 'review_requested' ? 'task.review_requested' : `task.${status}`;
if (['task.completed', 'task.blocked', 'task.cancelled', 'task.review_requested'].includes(eventType)) {
  const eventsFile = join(dataDir, 'events.jsonl');
  mkdirSync(dirname(eventsFile), { recursive: true });
  appendFileSync(eventsFile, JSON.stringify({
    type: eventType,
    timestamp: new Date().toISOString(),
    payload: { taskId, status },
  }) + '\n');
}
console.log(`Task ${taskId} marked as ${status}`);
ctx.db.close();
