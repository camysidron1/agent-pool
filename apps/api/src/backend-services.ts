import { createCanonicalStateServices, type CreateProjectInput, type ProjectRecord } from "@agent-pool/db";
import type { ProjectQueueDeclaration, RabbitMqAdapter } from "@agent-pool/queue";

import type { ApiDatabaseConnection } from "./database";

export type ApiBackendServicesOptions = {
  readonly database: ApiDatabaseConnection;
  readonly queue: RabbitMqAdapter;
};

export type CreateProjectWithQueuesResult = {
  readonly project: ProjectRecord;
  readonly queues: readonly ProjectQueueDeclaration[];
};

export function createApiBackendServices(options: ApiBackendServicesOptions) {
  const state = createCanonicalStateServices(options.database.sqlite);

  return {
    ...state,
    createProjectWithQueues(input: CreateProjectInput): CreateProjectWithQueuesResult {
      const project = state.createProject(input);
      const queues = options.queue.declareProjectQueues(project.id);

      return { project, queues };
    },
  };
}

