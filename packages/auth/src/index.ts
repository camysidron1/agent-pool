import { TEST_OPERATOR_IDENTITY, type OperatorIdentity } from "@agent-pool/config";

export type AuthenticatedOperator = OperatorIdentity;

export const AUTH_PACKAGE_BOUNDARY = {
  browserSafeEntrypoint: false,
  testIdentityId: TEST_OPERATOR_IDENTITY.id,
} as const;

export function getTestOperatorIdentity(): AuthenticatedOperator {
  return TEST_OPERATOR_IDENTITY;
}
