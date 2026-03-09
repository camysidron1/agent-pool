import { EventBus } from "../daemon/event-bus";
import { IntegrationManager } from "../integrations/manager";

export interface IntegrationCommandOptions {
  dataDir: string;
}

/**
 * Handle `agent-pool integration list` — show discovered integrations.
 */
export async function integrationList(
  options: IntegrationCommandOptions
): Promise<string> {
  const bus = new EventBus();
  const manager = new IntegrationManager(options.dataDir, bus);
  const integrations = await manager.discover();

  if (integrations.length === 0) {
    return "No integrations found.";
  }

  const lines: string[] = ["Integrations:"];
  for (const integration of integrations) {
    const events = Object.keys(integration.events).join(", ");
    lines.push(`  ${integration.name} v${integration.version}`);
    lines.push(`    events: ${events || "(none)"}`);
  }

  return lines.join("\n");
}

/**
 * Handle `agent-pool integration validate <name>` — validate an integration.
 */
export async function integrationValidate(
  options: IntegrationCommandOptions,
  name: string
): Promise<string> {
  const bus = new EventBus();
  const manager = new IntegrationManager(options.dataDir, bus);
  const result = await manager.validateFiles(name);

  if (result.valid) {
    return `Integration '${name}' is valid.`;
  }

  const lines = [`Integration '${name}' has errors:`];
  for (const error of result.errors) {
    lines.push(`  - ${error}`);
  }
  return lines.join("\n");
}
