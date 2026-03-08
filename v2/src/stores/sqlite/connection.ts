import { Database } from 'bun:sqlite';

/**
 * Create and configure a SQLite database connection.
 * No singletons — caller owns the lifecycle.
 */
export function createDatabase(dbPath: string): Database {
  const db = new Database(dbPath, { create: true });

  // Performance and safety pragmas
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 5000');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA synchronous = NORMAL');

  return db;
}
