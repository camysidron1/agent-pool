import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";
import { createRabbitMqAdapter } from "@agent-pool/queue";

import type { CommandHandlingRequest, ControlQueueConsumerBackend } from "../src/control-consumer";
import { runControlQueueConsumerOnce } from "../src/control-consumer";

describe("orchestrator control queue consumer", () => {
  test("claims control wakeups and does not duplicate command handling for duplicate messages", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const handled: CommandHandlingRequest[] = [];
    const reports: string[] = [];
    let claims = 0;
    const backend: ControlQueueConsumerBackend = {
      claimNextCommand: async () => {
        claims += 1;

        if (claims === 1) {
          return {
            ok: true,
            status: 200,
            body: {
              ok: true,
              claimed: true,
              command: { id: "command_1", type: "cancel" },
              event: { id: "event_1", projectId: "project_a", type: "command.claimed" },
              outbox: { id: "outbox_1", projectId: "project_a", eventId: "event_1", routingKey: "command.claimed" },
            },
          };
        }

        return {
          ok: true,
          status: 200,
          body: { ok: true, claimed: false, reason: "no_queued_command" },
        };
      },
      reportCommandStarted: async (input) => {
        reports.push(`started:${input.commandId}`);
        return commandReport(input.commandId);
      },
      reportCommandSucceeded: async (input) => {
        reports.push(`succeeded:${input.commandId}`);
        return commandReport(input.commandId);
      },
      reportCommandFailed: async () => {
        throw new Error("command failed report should not be called");
      },
    };

    const firstHint = queue.publishProjectControlHint("project_a", { commandId: "command_1" });
    const secondHint = queue.publishProjectControlHint("project_a", { commandId: "command_1" });

    expect(firstHint.queue).toBe("project-control.project_a");
    expect(secondHint.queue).toBe("project-control.project_a");
    expect(queue.publishedHints.map((hint) => hint.queue)).not.toContain("session-session_1");

    const result = await runControlQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
      commandHandler: async (request) => {
        handled.push(request);
        return { ok: true };
      },
    });

    expect(result).toEqual({
      queue: "project-control.project_a",
      processed: 2,
      acked: 2,
      retried: 0,
      deadLettered: 0,
      claimed: 1,
      noWork: 1,
      commandsStarted: 1,
      commandsSucceeded: 1,
      commandsFailed: 0,
    });
    expect(claims).toBe(2);
    expect(handled).toHaveLength(1);
    expect(handled[0]).toMatchObject({
      projectId: "project_a",
      command: { id: "command_1", type: "cancel" },
      wakeup: { commandId: "command_1" },
    });
    expect(reports).toEqual(["started:command_1", "succeeded:command_1"]);
    expect(queue.publishedHints).toEqual([]);
  });

  test("reports unsupported commands as structured failures without provider calls", async () => {
    const queue = createRabbitMqAdapter(loadConfig({ AUTH_MODE: "test" }).rabbitmq);
    const failedReports: unknown[] = [];
    const backend: ControlQueueConsumerBackend = {
      claimNextCommand: async () => ({
        ok: true,
        status: 200,
        body: {
          ok: true,
          claimed: true,
          command: { id: "command_future", type: "future-provider-command" },
          event: { id: "event_2", projectId: "project_a", type: "command.claimed" },
          outbox: { id: "outbox_2", projectId: "project_a", eventId: "event_2", routingKey: "command.claimed" },
        },
      }),
      reportCommandStarted: async (input) => commandReport(input.commandId),
      reportCommandSucceeded: async () => {
        throw new Error("unsupported command should not be reported succeeded");
      },
      reportCommandFailed: async (input) => {
        failedReports.push(input);
        return commandReport(input.commandId);
      },
    };

    queue.publishProjectControlHint("project_a", { commandId: "command_future" });

    const result = await runControlQueueConsumerOnce({
      projectId: "project_a",
      queue,
      backend,
    });

    expect(result).toMatchObject({
      processed: 1,
      acked: 1,
      retried: 0,
      deadLettered: 0,
      claimed: 1,
      noWork: 0,
      commandsStarted: 1,
      commandsSucceeded: 0,
      commandsFailed: 1,
    });
    expect(failedReports).toEqual([
      {
        projectId: "project_a",
        commandId: "command_future",
        errorMessage: "unsupported command type for orchestrator skeleton: future-provider-command",
      },
    ]);
  });
});

function commandReport(commandId: string) {
  return {
    ok: true,
    status: 200,
    body: {
      ok: true,
      idempotent: false,
      command: { id: commandId },
      event: null,
      outbox: null,
    },
  } as const;
}
