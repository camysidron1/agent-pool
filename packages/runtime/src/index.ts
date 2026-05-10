export type RuntimeProviderKind = "fake" | "e2b" | "docker";

export type RuntimeSessionRequest = {
  readonly projectId: string;
  readonly taskId: string;
};

export type RuntimeSessionHandle = {
  readonly provider: RuntimeProviderKind;
  readonly sessionId: string;
};

export interface RuntimeProvider {
  readonly kind: RuntimeProviderKind;
  startSession(request: RuntimeSessionRequest): Promise<RuntimeSessionHandle>;
  stopSession(handle: RuntimeSessionHandle): Promise<void>;
}

export const RUNTIME_PACKAGE_BOUNDARY = {
  providerInterfaceOnly: true,
  realE2BImplementationIncluded: false,
} as const;
