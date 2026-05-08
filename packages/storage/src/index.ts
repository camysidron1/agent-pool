export type StorageObjectKey = string;

export type StorageObjectRef = {
  readonly bucket: string;
  readonly key: StorageObjectKey;
};

export const STORAGE_PACKAGE_BOUNDARY = {
  defaultMvpBackend: "local-or-minio-placeholder",
  noProviderRuntimeAccess: true,
} as const;
