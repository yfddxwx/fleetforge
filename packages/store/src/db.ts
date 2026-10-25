import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export type Database = Database.Database;

interface Migration {
  version: number;
  name: string;
  up: (db: Database) => void;
}

export const MIGRATIONS: Migration[] = [
  {
    version: 1,
    name: "core-tables",
    up: (db) => {
      db.exec(`
        CREATE TABLE tasks (
          id TEXT PRIMARY KEY,
          title TEXT NOT NULL,
          prompt TEXT NOT NULL,
          agent TEXT NOT NULL,
          model TEXT,
          repo_path TEXT NOT NULL,
          base_branch TEXT NOT NULL,
          branch TEXT,
          worktree_path TEXT,
          priority INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL,
          merge_strategy TEXT NOT NULL DEFAULT 'ff',
          max_attempts INTEGER NOT NULL DEFAULT 1,
          attempt INTEGER NOT NULL DEFAULT 1,
          session_id TEXT,
          cost_usd REAL NOT NULL DEFAULT 0,
          exit_code INTEGER,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL,
          started_at INTEGER,
          finished_at INTEGER
        );
        CREATE INDEX idx_tasks_status ON tasks(status);
        CREATE INDEX idx_tasks_repo ON tasks(repo_path);

        CREATE TABLE sessions (
          id TEXT PRIMARY KEY,
          task_id TEXT NOT NULL REFERENCES tasks(id),
          driver TEXT NOT NULL,
          status TEXT NOT NULL,
          pid INTEGER,
          model TEXT,
          external_ref TEXT,
          attempt INTEGER NOT NULL DEFAULT 1,
          started_at INTEGER NOT NULL,
          heartbeat_at INTEGER NOT NULL,
          ended_at INTEGER,
          exit_code INTEGER,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          cost_usd REAL NOT NULL DEFAULT 0
        );
        CREATE INDEX idx_sessions_task ON sessions(task_id);
        CREATE INDEX idx_sessions_status ON sessions(status);

        CREATE TABLE events (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL REFERENCES sessions(id),
          task_id TEXT NOT NULL,
          seq INTEGER NOT NULL,
          ts INTEGER NOT NULL,
          schema_version INTEGER NOT NULL,
          kind TEXT NOT NULL,
          payload TEXT NOT NULL,
          UNIQUE(session_id, seq)
        );
        CREATE INDEX idx_events_task ON events(task_id, seq);

        CREATE TABLE usage (
          id TEXT PRIMARY KEY,
          session_id TEXT NOT NULL,
          task_id TEXT NOT NULL,
          driver TEXT NOT NULL,
          model TEXT,
          input_tokens INTEGER NOT NULL,
          output_tokens INTEGER NOT NULL,
          cache_read_tokens INTEGER NOT NULL DEFAULT 0,
          cache_write_tokens INTEGER NOT NULL DEFAULT 0,
          ts INTEGER NOT NULL,
          cost_usd REAL NOT NULL
        );
        CREATE INDEX idx_usage_task ON usage(task_id);
        CREATE INDEX idx_usage_ts ON usage(ts);

        CREATE TABLE worktree_locks (
          worktree_path TEXT PRIMARY KEY,
          branch TEXT NOT NULL UNIQUE,
          task_id TEXT NOT NULL UNIQUE,
          acquired_at INTEGER NOT NULL
        );

        CREATE TABLE settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
      `);
    },
  },
  {
    version: 2,
    name: "session-descendant-pids",
    up: (db) => {
      // Periodic snapshots of an agent's process tree: if the server is hard-
      // killed, the agent's own children/grandchildren may outlive it while the
      // recorded session pid is already gone. These snapshots are what the
      // startup sweep reaps (ADR-0005).
      db.exec(`ALTER TABLE sessions ADD COLUMN descendants TEXT NOT NULL DEFAULT '[]'`);
    },
  },
];

/**
 * Open (and migrate) the fleet database.
 * WAL keeps readers (web/CLI) off the writer's back; foreign keys are on.
 */
export function openDatabase(file: string): Database {
  mkdirSync(dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  migrate(db);
  return db;
}

export function migrate(db: Database): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);
  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => (r as { version: number }).version),
  );
  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue;
    const apply = db.transaction(() => {
      migration.up(db);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(
        migration.version,
        migration.name,
        Date.now(),
      );
    });
    apply();
  }
}
