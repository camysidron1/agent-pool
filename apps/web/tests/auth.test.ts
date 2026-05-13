import { describe, expect, test } from "bun:test";

import {
  clearStoredOperatorId,
  normalizeOperatorId,
  OPERATOR_ID_STORAGE_KEY,
  readStoredOperatorId,
  saveStoredOperatorId,
  type BrowserStorage,
} from "../src/auth";

describe("operator auth storage", () => {
  test("normalizes blank and padded operator ids", () => {
    expect(normalizeOperatorId("  operator-test  ")).toBe("operator-test");
    expect(normalizeOperatorId("   ")).toBeNull();
  });

  test("stores reads and clears operator ids", () => {
    const storage = new MemoryStorage();

    saveStoredOperatorId(storage, "  operator-test  ");
    expect(storage.getItem(OPERATOR_ID_STORAGE_KEY)).toBe("operator-test");
    expect(readStoredOperatorId(storage)).toBe("operator-test");

    clearStoredOperatorId(storage);
    expect(readStoredOperatorId(storage)).toBeNull();
  });

  test("treats unavailable storage as unauthenticated", () => {
    const storage: BrowserStorage = {
      getItem: () => {
        throw new Error("blocked");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };

    expect(readStoredOperatorId(storage)).toBeNull();
    expect(() => saveStoredOperatorId(storage, "operator-test")).not.toThrow();
    expect(() => clearStoredOperatorId(storage)).not.toThrow();
  });
});

class MemoryStorage implements BrowserStorage {
  readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }
}
