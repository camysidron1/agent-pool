import { appendFile, mkdir } from "fs/promises";
import { join, dirname } from "path";

export type EventType =
  | "task.created"
  | "task.claimed"
  | "task.completed"
  | "task.blocked"
  | "task.cancelled"
  | "agent.ready"
  | "agent.stuck";

export const VALID_EVENT_TYPES: ReadonlySet<string> = new Set<EventType>([
  "task.created",
  "task.claimed",
  "task.completed",
  "task.blocked",
  "task.cancelled",
  "agent.ready",
  "agent.stuck",
]);

export interface PoolEvent {
  type: EventType;
  timestamp: string;
  payload: Record<string, unknown>;
}

export type EventHandler = (event: PoolEvent) => void | Promise<void>;

export class EventBus {
  private handlers = new Map<EventType, Set<EventHandler>>();
  private eventsFile: string | null;
  private logger: (msg: string) => void;

  constructor(
    eventsFile: string | null = null,
    logger: (msg: string) => void = console.warn
  ) {
    this.eventsFile = eventsFile;
    this.logger = logger;
  }

  on(type: EventType, handler: EventHandler): void {
    let set = this.handlers.get(type);
    if (!set) {
      set = new Set();
      this.handlers.set(type, set);
    }
    set.add(handler);
  }

  off(type: EventType, handler: EventHandler): void {
    const set = this.handlers.get(type);
    if (set) {
      set.delete(handler);
      if (set.size === 0) this.handlers.delete(type);
    }
  }

  emit(event: PoolEvent): void {
    // Persist event if configured (fire-and-forget)
    if (this.eventsFile) {
      this.persistEvent(event).catch((err) => {
        this.logger(`EventBus: failed to persist event: ${err}`);
      });
    }

    const set = this.handlers.get(event.type);
    if (!set) return;

    for (const handler of set) {
      try {
        const result = handler(event);
        // If handler returns a promise, catch its rejection
        if (result && typeof result.catch === "function") {
          result.catch((err: unknown) => {
            this.logger(
              `EventBus: async handler error for ${event.type}: ${err}`
            );
          });
        }
      } catch (err) {
        this.logger(`EventBus: handler error for ${event.type}: ${err}`);
      }
    }
  }

  /**
   * Append event to the JSONL events file for degraded-mode replay.
   */
  async persistEvent(event: PoolEvent): Promise<void> {
    if (!this.eventsFile) return;
    await mkdir(dirname(this.eventsFile), { recursive: true });
    await appendFile(this.eventsFile, JSON.stringify(event) + "\n");
  }
}
