import { describe, expect, test } from "bun:test";

import { loadConfig } from "@agent-pool/config";

import { STORAGE_PACKAGE_BOUNDARY, createStorageAdapter, createStorageObjectKey } from "../src";

describe("storage adapter skeleton", () => {
  test("plans local storage object paths deterministically", () => {
    const adapter = createStorageAdapter(
      loadConfig({ AUTH_MODE: "test", STORAGE_LOCAL_ROOT: "/tmp/agent-pool-storage", STORAGE_BUCKET: "test-bucket" }).storage,
    );

    expect(adapter.kind).toBe("local");
    expect(adapter.planObject(["projects", "project_a", "artifact.md"])).toEqual({
      adapter: "local",
      bucket: "test-bucket",
      key: "projects/project_a/artifact.md",
      localPath: "/tmp/agent-pool-storage/projects/project_a/artifact.md",
    });
  });

  test("plans blob storage keys without provider calls", () => {
    const adapter = createStorageAdapter(
      loadConfig({ AUTH_MODE: "test", STORAGE_ADAPTER: "blob", STORAGE_BUCKET: "blob-bucket" }).storage,
    );

    expect(adapter.planObject(["logs", "../session.log"])).toEqual({
      adapter: "blob",
      bucket: "blob-bucket",
      key: "logs/_/session.log",
      localPath: null,
    });
    expect(STORAGE_PACKAGE_BOUNDARY.noPaidProviderCallsInTests).toBe(true);
  });

  test("rejects empty object keys", () => {
    expect(() => createStorageObjectKey([" ", "/"])).toThrow("storage object key requires");
  });
});
