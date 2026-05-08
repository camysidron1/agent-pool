export type DatabaseOwner = "backend-api";

export type WebSandboxDatabaseConfig = {
  readonly owner: DatabaseOwner;
  readonly path: string;
};

export const DB_PACKAGE_BOUNDARY = {
  owner: "backend-api",
  opensSqliteOnlyInBackendApi: true,
  mustNotBeImportedByWebOrOrchestrator: true,
} as const;

export function createWebSandboxDatabaseConfig(path: string): WebSandboxDatabaseConfig {
  return {
    owner: "backend-api",
    path,
  };
}
