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
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}
