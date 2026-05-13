export const OPERATOR_ID_STORAGE_KEY = "agent-pool.operatorId";

export type BrowserStorage = Pick<Storage, "getItem" | "removeItem" | "setItem">;

export function normalizeOperatorId(value: string): string | null {
  const normalized = value.trim();
  return normalized.length > 0 ? normalized : null;
}

export function readStoredOperatorId(storage: BrowserStorage | null): string | null {
  if (!storage) return null;

  try {
    const value = storage.getItem(OPERATOR_ID_STORAGE_KEY);
    return value ? normalizeOperatorId(value) : null;
  } catch {
    return null;
  }
}

export function saveStoredOperatorId(storage: BrowserStorage | null, operatorId: string): void {
  if (!storage) return;
  const normalized = normalizeOperatorId(operatorId);
  if (!normalized) return;

  try {
    storage.setItem(OPERATOR_ID_STORAGE_KEY, normalized);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}

export function clearStoredOperatorId(storage: BrowserStorage | null): void {
  if (!storage) return;

  try {
    storage.removeItem(OPERATOR_ID_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in restricted browser contexts.
  }
}
