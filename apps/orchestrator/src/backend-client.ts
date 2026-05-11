import { createServiceTokenHeaders } from "@agent-pool/auth";
import type { AppConfig } from "@agent-pool/config";

export type BackendHealthClientOptions = {
  readonly config: AppConfig;
  readonly fetch?: typeof fetch;
};

export type BackendInternalHealthResult =
  | { readonly ok: true; readonly status: number; readonly body: unknown }
  | { readonly ok: false; readonly status: number; readonly body: unknown };

export async function checkBackendInternalHealth(
  options: BackendHealthClientOptions,
): Promise<BackendInternalHealthResult> {
  const fetchImpl = options.fetch ?? fetch;
  const response = await fetchImpl(`${options.config.orchestrator.backendInternalUrl}/internal/health`, {
    headers: createServiceTokenHeaders(options.config.serviceToken),
  });
  const body = await response.json().catch(() => null);

  return {
    ok: response.ok,
    status: response.status,
    body,
  };
}
