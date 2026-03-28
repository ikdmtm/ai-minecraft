import type Database from 'better-sqlite3';

const MIGRATIONS = [
  `CREATE TABLE IF NOT EXISTS state (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS death_history (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    generation       INTEGER NOT NULL,
    survival_minutes REAL    NOT NULL,
    cause            TEXT    NOT NULL,
    lesson           TEXT    NOT NULL,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now'))
  )`,
  `CREATE TABLE IF NOT EXISTS action_log (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT NOT NULL,
    type      TEXT NOT NULL,
    content   TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS config (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
];

export function runMigrations(db: Database.Database): void {
  db.transaction(() => {
    for (const sql of MIGRATIONS) {
      db.exec(sql);
    }
  })();
}
