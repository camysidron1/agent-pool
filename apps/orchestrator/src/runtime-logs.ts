import type { RuntimeLifecycleLogEvent, RuntimeLifecycleLogger } from "@agent-pool/runtime";

export type ConsoleRuntimeLoggerOptions = {
  readonly clock?: { readonly now: () => Date };
  readonly write?: Pick<typeof console, "debug" | "error" | "info" | "warn">;
};

export function createConsoleRuntimeLogger(options: ConsoleRuntimeLoggerOptions = {}): RuntimeLifecycleLogger {
  const clock = options.clock ?? { now: () => new Date() };
  const writer = options.write ?? console;

  return (event: RuntimeLifecycleLogEvent): void => {
    const level = event.level ?? "info";
    const record = {
      timestamp: clock.now().toISOString(),
      service: "agent-pool-orchestrator",
      ...event,
      level,
    };
    const line = JSON.stringify(record);

    if (level === "error") {
      writer.error(line);
      return;
    }
    if (level === "warn") {
      writer.warn(line);
      return;
    }
    if (level === "debug") {
      writer.debug(line);
      return;
    }
    writer.info(line);
  };
}
