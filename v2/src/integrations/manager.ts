import { readdir, readFile, access } from "fs/promises";
import { join } from "path";
import { EventBus, VALID_EVENT_TYPES, type PoolEvent, type EventType } from "../daemon/event-bus";
import type { IntegrationManifest } from "./types";

export class IntegrationManager {
  private dataDir: string;
  private bus: EventBus;
  private integrations: IntegrationManifest[] = [];
  private logger: (msg: string) => void;

  constructor(
    dataDir: string,
    bus: EventBus,
    logger: (msg: string) => void = console.warn
  ) {
    this.dataDir = dataDir;
    this.bus = bus;
    this.logger = logger;
  }

  get integrationsDir(): string {
    return join(this.dataDir, "integrations");
  }

  /**
   * Scan integration directories and return discovered manifests.
   */
  async discover(): Promise<IntegrationManifest[]> {
    const manifests: IntegrationManifest[] = [];
    let entries: string[];
    try {
      entries = await readdir(this.integrationsDir);
    } catch {
      return [];
    }

    for (const entry of entries) {
      const manifestPath = join(this.integrationsDir, entry, "integration.json");
      try {
        const raw = await readFile(manifestPath, "utf-8");
        const manifest = JSON.parse(raw);
        const validation = this.validateManifest(manifest);
        if (validation.valid) {
          manifests.push(manifest as IntegrationManifest);
        } else {
          this.logger(
            `Integration ${entry}: invalid manifest — ${validation.errors.join(", ")}`
          );
        }
      } catch {
        // No manifest or invalid JSON, skip
      }
    }

    return manifests;
  }

  /**
   * Discover integrations and subscribe their handlers to bus events.
   */
  async load(): Promise<void> {
    this.integrations = await this.discover();

    for (const manifest of this.integrations) {
      for (const [eventType, mapping] of Object.entries(manifest.events)) {
        this.bus.on(eventType as EventType, (event: PoolEvent) => {
          this.executeHandler(manifest, mapping.handler, event, mapping.async ?? false);
        });
      }
    }
  }

  /**
   * Validate an integration manifest.
   */
  validateManifest(manifest: unknown): { valid: boolean; errors: string[] } {
    const errors: string[] = [];

    if (!manifest || typeof manifest !== "object") {
      return { valid: false, errors: ["Manifest must be an object"] };
    }

    const m = manifest as Record<string, unknown>;

    if (typeof m.name !== "string" || m.name.length === 0) {
      errors.push("Missing or invalid 'name' field");
    }
    if (typeof m.version !== "string" || m.version.length === 0) {
      errors.push("Missing or invalid 'version' field");
    }

    // Validate config
    if (m.config !== undefined) {
      if (typeof m.config !== "object" || m.config === null) {
        errors.push("'config' must be an object");
      } else {
        for (const [key, val] of Object.entries(m.config as Record<string, unknown>)) {
          if (!val || typeof val !== "object") {
            errors.push(`Config '${key}' must be an object`);
            continue;
          }
          const c = val as Record<string, unknown>;
          if (typeof c.env !== "string") {
            errors.push(`Config '${key}' missing 'env' string`);
          }
          if (typeof c.required !== "boolean") {
            errors.push(`Config '${key}' missing 'required' boolean`);
          }
        }
      }
    }

    // Validate events
    if (m.events === undefined) {
      errors.push("Missing 'events' field");
    } else if (typeof m.events !== "object" || m.events === null) {
      errors.push("'events' must be an object");
    } else {
      for (const [eventType, val] of Object.entries(m.events as Record<string, unknown>)) {
        if (!VALID_EVENT_TYPES.has(eventType)) {
          errors.push(`Unknown event type '${eventType}'`);
        }
        if (!val || typeof val !== "object") {
          errors.push(`Event '${eventType}' must be an object`);
          continue;
        }
        const e = val as Record<string, unknown>;
        if (typeof e.handler !== "string" || e.handler.length === 0) {
          errors.push(`Event '${eventType}' missing 'handler' string`);
        }
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Validate an integration's handler files exist and required env vars are set.
   */
  async validateFiles(
    name: string
  ): Promise<{ valid: boolean; errors: string[] }> {
    const errors: string[] = [];
    const integrationDir = join(this.integrationsDir, name);
    const manifestPath = join(integrationDir, "integration.json");

    let manifest: IntegrationManifest;
    try {
      const raw = await readFile(manifestPath, "utf-8");
      manifest = JSON.parse(raw);
    } catch {
      return { valid: false, errors: [`Cannot read manifest at ${manifestPath}`] };
    }

    const schemaErrors = this.validateManifest(manifest);
    if (!schemaErrors.valid) {
      return schemaErrors;
    }

    // Check handler files exist
    for (const [eventType, mapping] of Object.entries(manifest.events)) {
      const handlerPath = join(integrationDir, mapping.handler);
      try {
        await access(handlerPath);
      } catch {
        errors.push(`Handler file missing for '${eventType}': ${mapping.handler}`);
      }
    }

    // Check required env vars
    for (const [key, config] of Object.entries(manifest.config)) {
      if (config.required && !process.env[config.env]) {
        errors.push(`Required env var '${config.env}' (config '${key}') is not set`);
      }
    }

    return { valid: errors.length === 0, errors };
  }

  /**
   * Get the list of loaded integrations.
   */
  getIntegrations(): IntegrationManifest[] {
    return this.integrations;
  }

  /**
   * Spawn a handler script with event data on stdin.
   */
  private executeHandler(
    manifest: IntegrationManifest,
    handlerFile: string,
    event: PoolEvent,
    isAsync: boolean
  ): void {
    const integrationDir = join(this.integrationsDir, manifest.name);
    const handlerPath = join(integrationDir, handlerFile);
    const eventJson = JSON.stringify(event);

    // Build env vars from config
    const env: Record<string, string> = { ...process.env } as Record<string, string>;
    for (const [, config] of Object.entries(manifest.config)) {
      const val = process.env[config.env];
      if (val !== undefined) {
        env[`INTEGRATION_${config.env}`] = val;
      }
    }

    try {
      const proc = Bun.spawn(["sh", handlerPath], {
        stdin: new Blob([eventJson]),
        stdout: "ignore",
        stderr: "pipe",
        env,
        cwd: integrationDir,
      });

      if (!isAsync) {
        // Wait for completion but don't crash bus
        proc.exited
          .then((code) => {
            if (code !== 0) {
              this.logger(
                `Integration ${manifest.name}: handler ${handlerFile} exited with code ${code}`
              );
            }
          })
          .catch((err) => {
            this.logger(
              `Integration ${manifest.name}: handler ${handlerFile} error: ${err}`
            );
          });
      }
    } catch (err) {
      this.logger(
        `Integration ${manifest.name}: failed to spawn ${handlerFile}: ${err}`
      );
    }
  }
}
