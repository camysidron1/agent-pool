export type CapacityLease = {
  readonly release: () => void;
};

export type CapacityLimiter = {
  readonly maxConcurrent: number;
  readonly active: number;
  readonly available: boolean;
  readonly acquire: () => CapacityLease | null;
};

export type CapacityLimiterOptions = {
  readonly maxConcurrent: number;
  readonly initialActive?: number;
};

export function createCapacityLimiter(options: CapacityLimiterOptions): CapacityLimiter {
  const maxConcurrent = readNonNegativeInteger(options.maxConcurrent, "maxConcurrent");
  let active = readNonNegativeInteger(options.initialActive ?? 0, "initialActive");

  if (active > maxConcurrent) {
    active = maxConcurrent;
  }

  return {
    maxConcurrent,
    get active(): number {
      return active;
    },
    get available(): boolean {
      return active < maxConcurrent;
    },
    acquire(): CapacityLease | null {
      if (active >= maxConcurrent) {
        return null;
      }

      active += 1;
      let released = false;

      return {
        release(): void {
          if (released) return;
          released = true;
          active = Math.max(0, active - 1);
        },
      };
    },
  };
}

function readNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }

  return value;
}
