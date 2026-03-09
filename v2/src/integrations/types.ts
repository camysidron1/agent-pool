export interface IntegrationConfig {
  env: string;
  required: boolean;
}

export interface IntegrationEventMapping {
  handler: string;
  async?: boolean;
}

export interface IntegrationManifest {
  name: string;
  version: string;
  config: Record<string, IntegrationConfig>;
  events: Record<string, IntegrationEventMapping>;
}
