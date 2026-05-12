import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { discoverBridgeDocuments, type BridgeSessionOptions } from "../src";

const cleanupPaths: string[] = [];

afterEach(async () => {
  for (const path of cleanupPaths.splice(0)) {
    await rm(path, { recursive: true, force: true });
  }
});

describe("bridge document discovery", () => {
  test("discovers documents under agent-docs and shared-docs only", async () => {
    const workspaceRoot = await createWorkspaceFixture();

    await mkdir(join(workspaceRoot, "agent-docs", "nested"), { recursive: true });
    await mkdir(join(workspaceRoot, "shared-docs"), { recursive: true });
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "agent-docs", "nested", "result.md"), "hello");
    await writeFile(join(workspaceRoot, "shared-docs", "lesson.txt"), "lesson");
    await writeFile(join(workspaceRoot, "docs", "ignore.md"), "ignore");

    const documents = await discoverBridgeDocuments({
      session: testSession(),
      workspaceRoot,
    });

    expect(documents).toEqual([
      {
        kind: "document",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        path: "agent-docs/nested/result.md",
        title: "result.md",
        contentType: "text/markdown",
        sizeBytes: 5,
      },
      {
        kind: "document",
        projectId: "project_a",
        taskId: "task_1",
        sessionId: "session_1",
        path: "shared-docs/lesson.txt",
        title: "lesson.txt",
        contentType: "text/plain",
        sizeBytes: 6,
      },
    ]);
  });

  test("handles missing document roots and rejects roots outside the allowed set", async () => {
    const workspaceRoot = await createWorkspaceFixture();
    await mkdir(join(workspaceRoot, "docs"), { recursive: true });
    await writeFile(join(workspaceRoot, "docs", "ignore.md"), "ignore");

    const documents = await discoverBridgeDocuments({
      session: testSession(),
      workspaceRoot,
      allowedRoots: ["docs", "agent-docs"],
    });

    expect(documents).toEqual([]);
  });
});

async function createWorkspaceFixture(): Promise<string> {
  const path = await mkdir(join(tmpdir(), `agent-pool-bridge-docs-${crypto.randomUUID()}`), { recursive: true });

  if (!path) throw new Error("failed to create temp workspace");
  cleanupPaths.push(path);
  return path;
}

function testSession(): BridgeSessionOptions {
  return {
    projectId: "project_a",
    taskId: "task_1",
    sessionId: "session_1",
    callbackBaseUrl: "http://callback.test",
    sessionToken: {
      headerName: "x-agent-pool-session-token",
      token: "session-token",
    },
  };
}
