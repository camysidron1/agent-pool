import { describe, expect, test } from "bun:test";

import { createPublicApiClient, PublicApiError, PUBLIC_OPERATOR_ID_HEADER } from "../src/api";

describe("public web API client", () => {
  test("sends the public operator header to the public API namespace", async () => {
    const calls: { readonly url: string; readonly headers: Headers }[] = [];
    const client = createPublicApiClient({
      baseUrl: "https://agent-pool.example/",
      operatorId: "operator-test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), headers: new Headers(init?.headers) });
        return jsonResponse({ ok: true, projects: [] });
      },
    });

    await expect(client.listProjects()).resolves.toEqual({ ok: true, projects: [] });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe("https://agent-pool.example/api/public/projects");
    expect(calls[0]?.headers.get(PUBLIC_OPERATOR_ID_HEADER)).toBe("operator-test");
    expect(calls[0]?.headers.get("accept")).toBe("application/json");
  });

  test("throws structured public API errors", async () => {
    const client = createPublicApiClient({
      operatorId: "bad-operator",
      fetchImpl: async () =>
        jsonResponse({ ok: false, error: { code: "forbidden", message: "operator auth invalid" } }, 403),
    });

    try {
      await client.listProjects();
      throw new Error("expected listProjects to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(PublicApiError);
      expect((error as PublicApiError).status).toBe(403);
      expect((error as PublicApiError).code).toBe("forbidden");
      expect((error as PublicApiError).message).toBe("operator auth invalid");
    }
  });

  test("encodes project and task path segments for mutations", async () => {
    const calls: { readonly url: string; readonly body: string | null }[] = [];
    const client = createPublicApiClient({
      operatorId: "operator-test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
        return jsonResponse({ ok: true, task: { id: "task/id" }, pendingCommands: [] });
      },
    });

    await client.updateTaskPriority("project/id", "task/id", 3);

    expect(calls[0]?.url).toBe("/api/public/projects/project%2Fid/tasks/task%2Fid/priority");
    expect(calls[0]?.body).toBe('{"priority":3}');
  });

  test("plans uploads and sends steering through public session routes", async () => {
    const calls: { readonly url: string; readonly body: string | null }[] = [];
    const client = createPublicApiClient({
      operatorId: "operator-test",
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), body: typeof init?.body === "string" ? init.body : null });
        if (String(input).endsWith("/uploads/plan")) {
          return jsonResponse({
            ok: true,
            upload: {
              adapter: "local",
              bucket: "agent-pool-web-sandbox",
              key: "projects/project-a/task-a/session-a/context.txt",
              localPath: "/tmp/raw-local-path/context.txt",
              method: "local_path",
              contentType: "text/plain",
              expiresAt: null,
              headers: {},
              fields: {},
            },
          });
        }

        return jsonResponse({ ok: true, steering: { id: "steering-a" }, command: { id: "command-a" }, task: null, pendingCommands: [] });
      },
    });

    await client.planProjectUpload("project-a", {
      taskId: "task-a",
      sessionId: "session-a",
      fileName: "context.txt",
      contentType: "text/plain",
    });
    await client.steerSession("project-a", "task-a", "session-a", {
      body: "Keep going",
      attachments: [{ key: "projects/project-a/task-a/session-a/context.txt", bucket: "agent-pool-web-sandbox", fileName: "context.txt" }],
    });
    await client.interruptSession("project-a", "task-a", "session-a", {
      message: "Interrupt requested",
      steeringContext: { source: "web", messages: [{ id: "steer-a", body: "Keep going" }] },
    });

    expect(calls.map((call) => call.url)).toEqual([
      "/api/public/projects/project-a/uploads/plan",
      "/api/public/projects/project-a/tasks/task-a/sessions/session-a/steer",
      "/api/public/projects/project-a/tasks/task-a/sessions/session-a/interrupt",
    ]);
    expect(calls[1]?.body).toBe(
      '{"body":"Keep going","attachments":[{"key":"projects/project-a/task-a/session-a/context.txt","bucket":"agent-pool-web-sandbox","fileName":"context.txt"}]}',
    );
    expect(calls[1]?.body).not.toContain("raw-local-path");
    expect(calls[2]?.body).toContain('"steeringContext"');
  });

  test("creates updates and deletes task notes through public routes", async () => {
    const calls: { readonly method: string | undefined; readonly url: string; readonly body: string | null }[] = [];
    const client = createPublicApiClient({
      operatorId: "operator-test",
      fetchImpl: async (input, init) => {
        calls.push({ method: init?.method, url: String(input), body: typeof init?.body === "string" ? init.body : null });
        return jsonResponse({
          ok: true,
          note: { id: "note/id", body: "note" },
          event: { type: "note.created" },
          outbox: {},
          task: { id: "task/id", notes: [] },
        });
      },
    });

    await client.createTaskNote("project/id", "task/id", { body: "new note", sessionId: "session/id" });
    await client.updateTaskNote("project/id", "task/id", "note/id", { body: "updated note" });
    await client.deleteTaskNote("project/id", "task/id", "note/id");

    expect(calls).toEqual([
      {
        method: "POST",
        url: "/api/public/projects/project%2Fid/tasks/task%2Fid/notes",
        body: '{"body":"new note","sessionId":"session/id"}',
      },
      {
        method: "PATCH",
        url: "/api/public/projects/project%2Fid/tasks/task%2Fid/notes/note%2Fid",
        body: '{"body":"updated note"}',
      },
      {
        method: "DELETE",
        url: "/api/public/projects/project%2Fid/tasks/task%2Fid/notes/note%2Fid",
        body: null,
      },
    ]);
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
