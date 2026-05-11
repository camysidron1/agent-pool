import { TEST_OPERATOR_IDENTITY, type OperatorIdentity, type ServiceTokenConfig } from "@agent-pool/config";

export type AuthenticatedOperator = OperatorIdentity;

export type ServiceTokenVerificationResult =
  | { readonly ok: true; readonly subject: "internal-service" }
  | { readonly ok: false; readonly reason: "missing" | "invalid" };

export const AUTH_PACKAGE_BOUNDARY = {
  browserSafeEntrypoint: false,
  testIdentityId: TEST_OPERATOR_IDENTITY.id,
} as const;

export function getTestOperatorIdentity(): AuthenticatedOperator {
  return TEST_OPERATOR_IDENTITY;
}

export function createServiceTokenHeaders(config: ServiceTokenConfig): Readonly<Record<string, string>> {
  return {
    [config.headerName]: config.token,
  };
}

export function verifyServiceTokenHeader(
  headers: Pick<Headers, "get">,
  config: ServiceTokenConfig,
): ServiceTokenVerificationResult {
  const value = headers.get(config.headerName);

  if (!value) {
    return { ok: false, reason: "missing" };
  }

  if (value !== config.token) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, subject: "internal-service" };
}

export function verifyServiceTokenValue(value: string | undefined, config: ServiceTokenConfig): ServiceTokenVerificationResult {
  if (!value) {
    return { ok: false, reason: "missing" };
  }

  if (value !== config.token) {
    return { ok: false, reason: "invalid" };
  }

  return { ok: true, subject: "internal-service" };
}
