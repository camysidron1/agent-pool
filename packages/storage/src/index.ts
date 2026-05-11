import { join } from "node:path";

import type { StorageConfig } from "@agent-pool/config";

export type StorageObjectKey = string;

export type StorageObjectRef = {
  readonly bucket: string;
  readonly key: StorageObjectKey;
};

export type PlannedStorageObject = StorageObjectRef & {
  readonly adapter: StorageConfig["adapter"];
  readonly localPath: string | null;
};

export type StorageAdapter = {
  readonly kind: StorageConfig["adapter"];
  readonly bucket: string;
  readonly planObject: (parts: readonly string[]) => PlannedStorageObject;
};

export const STORAGE_PACKAGE_BOUNDARY = {
  defaultMvpBackend: "local-or-minio-placeholder",
  noProviderRuntimeAccess: true,
  noPaidProviderCallsInTests: true,
} as const;

export function createStorageAdapter(config: StorageConfig): StorageAdapter {
  return {
    kind: config.adapter,
    bucket: config.bucket,
    planObject(parts: readonly string[]): PlannedStorageObject {
      const key = createStorageObjectKey(parts);

      return {
        adapter: config.adapter,
        bucket: config.bucket,
        key,
        localPath: config.adapter === "local" ? join(config.localRoot, key) : null,
      };
    },
  };
}

export function createStorageObjectKey(parts: readonly string[]): StorageObjectKey {
  const safeParts = parts.map(sanitizePart).filter(Boolean);

  if (!safeParts.length) {
    throw new Error("storage object key requires at least one non-empty path part");
  }

  return safeParts.join("/");
}

function sanitizePart(part: string): string {
  return part.trim().replace(/^\/+|\/+$/g, "").replace(/\.\./g, "_");
}
