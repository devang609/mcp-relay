import initSqlJs, { type Database as SqlJsDatabase } from 'sql.js';
import fs from 'fs';
import path from 'path';

const DATA_DIR = process.env.DATA_DIR || '.';
const DB_PATH = path.join(DATA_DIR, 'mcprelay.db');

let db: ReturnType<typeof wrapDb>;
let rawDb: SqlJsDatabase;

interface PreparedStatement {
  run(...params: unknown[]): { changes: number };
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

function wrapDb(raw: SqlJsDatabase) {
  function save() {
    const data = raw.export();
    fs.writeFileSync(DB_PATH, Buffer.from(data));
  }

  return {
    prepare(sql: string): PreparedStatement {
      return {
        run(...params: unknown[]) {
          raw.run(sql, params as any);
          save();
          return { changes: raw.getRowsModified() };
        },
        get(...params: unknown[]): unknown {
          const stmt = raw.prepare(sql);
          stmt.bind(params as any);
          let result: unknown = undefined;
          if (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row: Record<string, unknown> = {};
            for (let i = 0; i < cols.length; i++) {
              row[cols[i]] = vals[i];
            }
            result = row;
          }
          stmt.free();
          return result;
        },
        all(...params: unknown[]): unknown[] {
          const stmt = raw.prepare(sql);
          stmt.bind(params as any);
          const rows: unknown[] = [];
          while (stmt.step()) {
            const cols = stmt.getColumnNames();
            const vals = stmt.get();
            const row: Record<string, unknown> = {};
            for (let i = 0; i < cols.length; i++) {
              row[cols[i]] = vals[i];
            }
            rows.push(row);
          }
          stmt.free();
          return rows;
        },
      };
    },
    exec(sql: string) {
      raw.exec(sql);
      save();
    },
    pragma(cmd: string) {
      raw.exec(`PRAGMA ${cmd}`);
    },
    close() {
      save();
      raw.close();
    },
  };
}

let initPromise: Promise<void> | null = null;

async function initDb() {
  const SQL = await initSqlJs();
  if (fs.existsSync(DB_PATH)) {
    const fileBuffer = fs.readFileSync(DB_PATH);
    rawDb = new SQL.Database(fileBuffer);
  } else {
    rawDb = new SQL.Database();
  }
  const wrapped = wrapDb(rawDb);
  wrapped.pragma('journal_mode = WAL');
  wrapped.pragma('foreign_keys = ON');
  wrapped.exec(`
    CREATE TABLE IF NOT EXISTS catalogs (
      server_url TEXT PRIMARY KEY,
      tools_json TEXT NOT NULL,
      fetched_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS counters (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_hash TEXT,
      tokens_in INTEGER DEFAULT 0,
      tokens_out INTEGER DEFAULT 0,
      tools_exposed INTEGER DEFAULT 0,
      catalog_size INTEGER DEFAULT 0,
      round_trips INTEGER DEFAULT 0,
      latency_ms INTEGER DEFAULT 0,
      execution_location TEXT DEFAULT 'browser',
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS relay_jobs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      method TEXT NOT NULL,
      params_json TEXT,
      result_json TEXT,
      error TEXT,
      status TEXT DEFAULT 'pending',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_relay_session_status
      ON relay_jobs(session_id, status);
  `);
  db = wrapped;
}

export function getDb() {
  if (!db) {
    throw new Error('Database not initialized. Call ensureDb() first.');
  }
  return db;
}

export async function ensureDb() {
  if (!initPromise) {
    initPromise = initDb();
  }
  await initPromise;
}

export function closeDb() {
  if (db) {
    db.close();
  }
}
