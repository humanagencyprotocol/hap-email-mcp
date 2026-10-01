import { existsSync, mkdirSync, copyFileSync, statSync } from "fs";
import { homedir } from "os";
import { join } from "path";

export interface Db {
  run(sql: string, params?: any[]): Promise<void>;
  get<T>(sql: string, params?: any[]): Promise<T | undefined>;
  all<T>(sql: string, params?: any[]): Promise<T[]>;
  close(): Promise<void>;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  folder TEXT CHECK(folder IN ('inbox','sent')) NOT NULL,
  from_name TEXT NOT NULL,
  from_email TEXT NOT NULL,
  to_json TEXT NOT NULL,
  cc_json TEXT,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  received_at TEXT NOT NULL,
  in_reply_to TEXT,
  case_id TEXT,
  receipt_id TEXT
);

-- The people's actual reply to a case, keyed by the case id that produced the
-- inbox message. Deliberately not joined by any tool query in src/tools — the
-- agent under test must not be able to read what it is being measured against.
CREATE TABLE IF NOT EXISTS reference_replies (
  case_id TEXT PRIMARY KEY,
  subject TEXT NOT NULL,
  body TEXT NOT NULL
);

-- Singleton: records that a simulation package was loaded, so a second load
-- (create-only) can be refused without re-reading the whole messages table.
CREATE TABLE IF NOT EXISTS simulation_load (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  package_sha256 TEXT NOT NULL,
  cases_loaded INTEGER NOT NULL,
  loaded_at TEXT NOT NULL
);

-- Calls the connector refused AFTER the gateway let them through. When the gateway
-- injected a receipt_id, a ticket exists for an action that never happened; this
-- table is the only place that says so (the ticket alone reads like a done action).
CREATE TABLE IF NOT EXISTS refusals (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  message TEXT NOT NULL
);

-- Every change the connector performed, one row per call — the effect each
-- ticket produced.
CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  at TEXT NOT NULL,
  tool TEXT NOT NULL,
  receipt_id TEXT,
  document_id TEXT,
  summary TEXT
);
`;

// SQLite adapter using better-sqlite3 (synchronous API wrapped in async)
async function createSqliteDb(dbPath: string): Promise<Db> {
  const { default: Database } = await import("better-sqlite3");

  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec(SCHEMA);

  return {
    async run(sql: string, params: any[] = []): Promise<void> {
      db.prepare(sql).run(...params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      return db.prepare(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      return db.prepare(sql).all(...params) as T[];
    },
    async close(): Promise<void> {
      db.close();
    },
  };
}

// Postgres adapter using pg Pool
async function createPostgresDb(connectionString: string): Promise<Db> {
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString });

  // Adapt SQLite-style ? placeholders to Postgres $1, $2, ... style
  function adaptSql(sql: string): string {
    let i = 0;
    return sql.replace(/\?/g, () => `$${++i}`);
  }

  const pgSchema = SCHEMA.replace(/datetime\('now'\)/g, "NOW()");

  const client = await pool.connect();
  try {
    await client.query(pgSchema);
  } finally {
    client.release();
  }

  return {
    async run(sql: string, params: any[] = []): Promise<void> {
      await pool.query(adaptSql(sql), params);
    },
    async get<T>(sql: string, params: any[] = []): Promise<T | undefined> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows[0] as T | undefined;
    },
    async all<T>(sql: string, params: any[] = []): Promise<T[]> {
      const result = await pool.query(adaptSql(sql), params);
      return result.rows as T[];
    },
    async close(): Promise<void> {
      await pool.end();
    },
  };
}

function maybeBackupSqlite(dbPath: string): void {
  const backupPath = dbPath.replace(/\.db$/, ".backup.db");
  if (!existsSync(dbPath)) return;

  const shouldBackup =
    !existsSync(backupPath) ||
    Date.now() - statSync(backupPath).mtimeMs > 24 * 60 * 60 * 1000;

  if (shouldBackup) {
    try {
      copyFileSync(dbPath, backupPath);
      console.error(`[email-mcp] backup written to ${backupPath}`);
    } catch (err) {
      console.error(`[email-mcp] backup failed: ${err}`);
    }
  }
}

export async function createDb(): Promise<Db> {
  const databaseUrl = process.env.DATABASE_URL ?? "";

  if (databaseUrl.startsWith("postgres://") || databaseUrl.startsWith("postgresql://")) {
    console.error("[email-mcp] using Postgres");
    return createPostgresDb(databaseUrl);
  }

  // SQLite path — honor HAP_DATA_DIR so docker (with a mounted /app/data) and
  // local dev (~/.hap) write to the same place the gateway uses. The gateway
  // injects HAP_DATA_DIR into the child env when spawning this MCP server.
  // Only create the data directory when the default path is actually used — an
  // explicit DATABASE_URL must not leave an empty ~/.hap behind.
  let dbPath = databaseUrl;
  if (!dbPath) {
    const hapDir = process.env.HAP_DATA_DIR ?? join(homedir(), ".hap");
    if (!existsSync(hapDir)) mkdirSync(hapDir, { recursive: true });
    dbPath = join(hapDir, "email.db");
  }
  maybeBackupSqlite(dbPath);

  console.error(`[email-mcp] using SQLite at ${dbPath}`);
  return createSqliteDb(dbPath);
}
