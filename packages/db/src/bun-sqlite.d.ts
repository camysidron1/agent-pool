declare module "bun:sqlite" {
  export type DatabaseOptions = {
    readonly create?: boolean;
    readonly readonly?: boolean;
    readonly strict?: boolean;
  };

  export class Database {
    constructor(filename: string, options?: DatabaseOptions);
    close(): void;
    exec(sql: string): void;
    query<TRow = unknown, TParams extends readonly unknown[] = readonly unknown[]>(sql: string): Statement<TRow, TParams>;
  }

  export class Statement<TRow = unknown, TParams extends readonly unknown[] = readonly unknown[]> {
    get(...params: TParams): TRow | null;
    run(...params: TParams): { changes: number; lastInsertRowid: number | bigint };
    all(...params: TParams): TRow[];
  }
}
