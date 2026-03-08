import { readdir, readFile } from "fs/promises";
import { join } from "path";
import type { HeartbeatData } from "../runner/watchdog";
import type { TaskStore } from "../stores/interfaces";

const STALE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Format a duration in milliseconds to a human-readable age string.
 */
function formatAge(ms: number): string {
  if (ms < 1000) return "just now";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ago`;
}

export interface StatusOptions {
  dataDir: string;
  taskStore: TaskStore;
}

/**
 * Display agent pool status including heartbeat information.
 */
export async function showStatus(options: StatusOptions): Promise<string> {
  const lines: string[] = [];

  // Show tasks summary
  const tasks = await options.taskStore.list();
  const byStatus = new Map<string, number>();
  for (const t of tasks) {
    byStatus.set(t.status, (byStatus.get(t.status) ?? 0) + 1);
  }

  lines.push("Tasks:");
  if (tasks.length === 0) {
    lines.push("  (none)");
  } else {
    for (const [status, count] of byStatus) {
      lines.push(`  ${status}: ${count}`);
    }
  }

  // Show heartbeat status
  const heartbeatDir = join(options.dataDir, "heartbeats");
  let heartbeats: HeartbeatData[] = [];
  let agentIds: string[] = [];

  try {
    const files = await readdir(heartbeatDir);
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = await readFile(join(heartbeatDir, file), "utf-8");
        const data: HeartbeatData = JSON.parse(raw);
        heartbeats.push(data);
        agentIds.push(file.replace(/\.json$/, ""));
      } catch {
        // skip corrupted files
      }
    }
  } catch {
    // no heartbeat directory yet
  }

  if (heartbeats.length > 0) {
    lines.push("");
    lines.push("Active Agents:");
    const now = Date.now();
    for (let i = 0; i < heartbeats.length; i++) {
      const hb = heartbeats[i];
      const age = now - new Date(hb.timestamp).getTime();
      const ageStr = formatAge(age);
      const stale = age > STALE_THRESHOLD_MS;
      const marker = stale ? " [STALE]" : "";
      lines.push(
        `  ${agentIds[i]}  task=${hb.task_id}  heartbeat=${ageStr}${marker}`
      );
    }
  }

  return lines.join("\n");
}
