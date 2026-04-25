// Pi extension for agent-pool: per-turn context injection and transcript logging

import { writeFileSync, appendFileSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import type { ExtensionFactory } from '@mariozechner/pi-coding-agent';
import type { TaskStore } from '../../stores/interfaces.js';

export interface PoolExtensionConfig {
  taskStore: TaskStore;
  projectName: string;
  logPath: string;
  agentId: string;
  taskId: string;
}

/** Create an ExtensionFactory that injects queue state and logs tool calls. */
export function createPoolExtension(config: PoolExtensionConfig): ExtensionFactory {
  return (pi) => {
    // Ensure log directory exists
    mkdirSync(dirname(config.logPath), { recursive: true });
    writeFileSync(config.logPath, `--- agent-pool session: ${config.agentId} / ${config.taskId} ---\n`);

    // Inject live queue summary before each LLM turn
    pi.on('context', (_event, _ctx) => {
      const tasks = config.taskStore.getAll(config.projectName);
      const counts: Record<string, number> = {};
      for (const t of tasks) {
        counts[t.status] = (counts[t.status] ?? 0) + 1;
      }
      const parts = Object.entries(counts).map(([s, n]) => `${n} ${s}`);
      const summary = parts.length > 0 ? parts.join(', ') : 'empty';

      return {
        messages: [
          {
            role: 'user' as const,
            content: `[agent-pool queue: ${summary}]`,
          },
        ],
      };
    });

    // Log tool calls to transcript
    pi.on('tool_execution_start', (event, _ctx) => {
      const line = `[tool] ${event.toolName}(${JSON.stringify(event.input ?? {}).slice(0, 200)})\n`;
      appendFileSync(config.logPath, line);
    });

    // Log tool results to transcript
    pi.on('tool_execution_end', (event, _ctx) => {
      const resultPreview = JSON.stringify(event.result ?? '').slice(0, 300);
      const line = `[result] ${event.toolName}: ${resultPreview}\n`;
      appendFileSync(config.logPath, line);
    });

    // Log assistant messages to transcript
    pi.on('message_end', (event, _ctx) => {
      if (event.message?.role === 'assistant') {
        const text = typeof event.message.content === 'string'
          ? event.message.content
          : Array.isArray(event.message.content)
            ? event.message.content
                .filter((b: any) => b.type === 'text')
                .map((b: any) => b.text)
                .join('')
            : '';
        if (text) {
          appendFileSync(config.logPath, `[assistant] ${text.slice(0, 500)}\n`);
        }
      }
    });
  };
}
