import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm, chmod } from "fs/promises";
import { join } from "path";
import { tmpdir } from "os";
import { EventBus, type PoolEvent } from "../../../src/daemon/event-bus";
import { IntegrationManager } from "../../../src/integrations/manager";

describe("IntegrationManager", () => {
  let tmpDir: string;
  let integrationsDir: string;
  let bus: EventBus;
  let logs: string[];

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "intmgr-"));
    integrationsDir = join(tmpDir, "integrations");
    await mkdir(integrationsDir, { recursive: true });
    logs = [];
    bus = new EventBus(null, (msg) => logs.push(msg));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  async function createIntegration(
    name: string,
    manifest: Record<string, unknown>,
    handlers: Record<string, string> = {}
  ) {
    const dir = join(integrationsDir, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "integration.json"),
      JSON.stringify(manifest)
    );
    for (const [filename, content] of Object.entries(handlers)) {
      const path = join(dir, filename);
      await writeFile(path, content);
      await chmod(path, 0o755);
    }
  }

  const validManifest = {
    name: "test-integration",
    version: "1.0.0",
    config: {
      api_key: { env: "TEST_API_KEY", required: false },
    },
    events: {
      "task.completed": { handler: "on-complete.sh", async: true },
    },
  };

  describe("discover", () => {
    test("discovers integrations from directory structure", async () => {
      await createIntegration("slack-notify", validManifest);
      await createIntegration("email-notify", {
        ...validManifest,
        name: "email-notify",
      });

      const manager = new IntegrationManager(tmpDir, bus);
      const found = await manager.discover();

      expect(found).toHaveLength(2);
      const names = found.map((m) => m.name).sort();
      expect(names).toEqual(["email-notify", "test-integration"]);
    });

    test("returns empty array when no integrations dir", async () => {
      const emptyDir = await mkdtemp(join(tmpdir(), "empty-"));
      const manager = new IntegrationManager(emptyDir, bus);
      const found = await manager.discover();
      expect(found).toHaveLength(0);
      await rm(emptyDir, { recursive: true, force: true });
    });

    test("skips directories without integration.json", async () => {
      await mkdir(join(integrationsDir, "no-manifest"), { recursive: true });
      await createIntegration("valid", validManifest);

      const manager = new IntegrationManager(tmpDir, bus);
      const found = await manager.discover();
      expect(found).toHaveLength(1);
    });
  });

  describe("validateManifest", () => {
    test("valid manifest passes validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest(validManifest);
      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    test("missing name fails validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest({
        ...validManifest,
        name: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("name"))).toBe(true);
    });

    test("missing version fails validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest({
        ...validManifest,
        version: undefined,
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("version"))).toBe(true);
    });

    test("invalid event type fails validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest({
        ...validManifest,
        events: {
          "invalid.event": { handler: "test.sh" },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Unknown event type"))).toBe(true);
    });

    test("missing events field fails validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest({
        name: "test",
        version: "1.0.0",
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("events"))).toBe(true);
    });

    test("non-object manifest fails validation", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      expect(manager.validateManifest(null).valid).toBe(false);
      expect(manager.validateManifest("string").valid).toBe(false);
      expect(manager.validateManifest(42).valid).toBe(false);
    });

    test("event missing handler string fails", () => {
      const manager = new IntegrationManager(tmpDir, bus);
      const result = manager.validateManifest({
        ...validManifest,
        events: {
          "task.created": { handler: "" },
        },
      });
      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("handler"))).toBe(true);
    });
  });

  describe("validateFiles", () => {
    test("missing handler file detected", async () => {
      await createIntegration("missing-handler", {
        ...validManifest,
        name: "missing-handler",
      });
      // No handler file created

      const manager = new IntegrationManager(tmpDir, bus);
      const result = await manager.validateFiles("missing-handler");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Handler file missing"))).toBe(true);
    });

    test("missing required env var detected", async () => {
      const manifest = {
        name: "env-check",
        version: "1.0.0",
        config: {
          webhook: { env: "DEFINITELY_NOT_SET_XYZ_12345", required: true },
        },
        events: {
          "task.completed": { handler: "handler.sh", async: true },
        },
      };
      await createIntegration("env-check", manifest, {
        "handler.sh": "#!/bin/sh\necho ok",
      });

      const manager = new IntegrationManager(tmpDir, bus);
      const result = await manager.validateFiles("env-check");

      expect(result.valid).toBe(false);
      expect(result.errors.some((e) => e.includes("Required env var"))).toBe(true);
    });

    test("valid integration with handler files passes", async () => {
      await createIntegration("valid-int", {
        ...validManifest,
        name: "valid-int",
        config: {},
      }, {
        "on-complete.sh": "#!/bin/sh\necho ok",
      });

      const manager = new IntegrationManager(tmpDir, bus);
      const result = await manager.validateFiles("valid-int");

      expect(result.valid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });
  });

  describe("load and handler execution", () => {
    test("load subscribes handlers to bus events", async () => {
      await createIntegration("test-sub", {
        ...validManifest,
        name: "test-sub",
        config: {},
      }, {
        "on-complete.sh": "#!/bin/sh\ncat > /dev/null",
      });

      const manager = new IntegrationManager(tmpDir, bus, (msg) => logs.push(msg));
      await manager.load();

      expect(manager.getIntegrations()).toHaveLength(1);
    });

    test("handler spawned with correct stdin on event", async () => {
      // Create a handler that writes stdin to a file
      const outputFile = join(tmpDir, "output.json");
      await createIntegration("spawn-test", {
        name: "spawn-test",
        version: "1.0.0",
        config: {},
        events: {
          "task.created": { handler: "capture.sh", async: false },
        },
      }, {
        "capture.sh": `#!/bin/sh\ncat > "${outputFile}"`,
      });

      const manager = new IntegrationManager(tmpDir, bus, (msg) => logs.push(msg));
      await manager.load();

      const event: PoolEvent = {
        type: "task.created",
        timestamp: "2026-01-01T00:00:00Z",
        payload: { taskId: "t-042" },
      };
      bus.emit(event);

      // Wait for handler to complete
      await new Promise((r) => setTimeout(r, 500));

      const { readFile } = await import("fs/promises");
      const output = await readFile(outputFile, "utf-8");
      const parsed = JSON.parse(output);
      expect(parsed.type).toBe("task.created");
      expect(parsed.payload.taskId).toBe("t-042");
    });

    test("async handler doesn't block", async () => {
      // Create a slow async handler
      await createIntegration("async-test", {
        name: "async-test",
        version: "1.0.0",
        config: {},
        events: {
          "task.completed": { handler: "slow.sh", async: true },
        },
      }, {
        "slow.sh": "#!/bin/sh\nsleep 10",
      });

      const manager = new IntegrationManager(tmpDir, bus, (msg) => logs.push(msg));
      await manager.load();

      const start = Date.now();
      bus.emit({
        type: "task.completed",
        timestamp: new Date().toISOString(),
        payload: {},
      });
      const elapsed = Date.now() - start;

      // Should return almost immediately since async: true
      expect(elapsed).toBeLessThan(100);
    });
  });
});
