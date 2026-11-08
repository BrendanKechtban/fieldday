import pg from "pg";
import { migrations } from "./migrations.js";

export type Row = Record<string, unknown>;

/** Minimal async SQL surface shared by the Postgres pool, a transaction, and the in-process PGlite used for zero-setup dev/tests. */
export interface Queryable {
  query<T = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Run one or more statements with no parameters (migrations). */
  exec(sql: string): Promise<void>;
}
export interface DB extends Queryable {
  /** Run fn in one transaction; any throw rolls everything back. */
  tx<T>(fn: (q: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  readonly kind: "pg" | "pglite";
}

// COUNT/SUM come back as int8; this app's numbers are tiny, so return JS numbers instead of strings.
pg.types.setTypeParser(20, (v) => Number(v));

export interface OpenOptions {
  /** Put all objects in this schema (used by tests to isolate runs on one real server). */
  schema?: string;
  max?: number;
}

/**
 * DATABASE_URL forms:
 *   postgres://user:pass@host/db?sslmode=require   real Postgres (Neon, local, CI)
 *   pglite://memory                                 in-process, throwaway (tests)
 *   pglite://./some/dir                             in-process, persisted to a folder (local dev)
 */
export async function openDb(url: string, opts: OpenOptions = {}): Promise<DB> {
  if (url.startsWith("pglite://")) return openPglite(url.slice("pglite://".length));
  return openPg(url, opts);
}

function openPg(url: string, opts: OpenOptions): DB {
  const pool = new pg.Pool({
    connectionString: url,
    max: opts.max ?? 5,
    connectionTimeoutMillis: 15_000, // a scaled-to-zero serverless database can take a few seconds to wake
    idleTimeoutMillis: 10_000,
    allowExitOnIdle: true,
    ...(opts.schema ? { options: `-c search_path=${opts.schema}` } : {}),
  });
  // Without this, a dropped idle connection (the provider restarting or suspending) would crash the process.
  pool.on("error", (e) => console.error(JSON.stringify({ msg: "pg idle client error", error: e.message })));
  const wrap = (c: pg.Pool | pg.PoolClient): Queryable => ({
    async query<T = Row>(sql: string, params?: unknown[]) { return (await c.query(sql, params as unknown[] | undefined)).rows as T[]; },
    async exec(sql: string) { await c.query(sql); }, // no params => simple protocol => multiple statements allowed
  });
  return {
    kind: "pg",
    ...wrap(pool),
    async tx<T>(fn: (q: Queryable) => Promise<T>) {
      const c = await pool.connect();
      try {
        await c.query("BEGIN");
        const r = await fn(wrap(c));
        await c.query("COMMIT");
        return r;
      } catch (e) {
        try { await c.query("ROLLBACK"); } catch { /* connection already gone */ }
        throw e;
      } finally {
        c.release();
      }
    },
    close: () => pool.end(),
  };
}

async function openPglite(dir: string): Promise<DB> {
  let mod: typeof import("@electric-sql/pglite");
  try { mod = await import("@electric-sql/pglite"); }
  catch { throw new Error("pglite:// URLs need the dev dependency @electric-sql/pglite (not installed in production builds). Use a postgres:// DATABASE_URL."); }
  const p = new mod.PGlite(dir === "memory" ? undefined : dir);
  await p.waitReady;
  const wrap = (c: { query: (s: string, a?: unknown[]) => Promise<{ rows: unknown[] }>; exec: (s: string) => Promise<unknown> }): Queryable => ({
    async query<T = Row>(sql: string, params?: unknown[]) { return (await c.query(sql, params)).rows as T[]; },
    async exec(sql: string) { await c.exec(sql); },
  });
  return {
    kind: "pglite",
    ...wrap(p),
    tx: <T>(fn: (q: Queryable) => Promise<T>) => p.transaction((t) => fn(wrap(t))),
    close: () => p.close(),
  };
}

const MIGRATION_LOCK = 7000; // advisory-lock key: two instances starting at once must not both migrate
const LIVE_LOG_LOCK = 7001; // see logLive() in service.ts

export { LIVE_LOG_LOCK };

async function ensureTable(q: Queryable) {
  await q.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
}

export async function currentVersion(q: Queryable): Promise<number> {
  await ensureTable(q);
  const rows = await q.query<{ v: number }>("SELECT COALESCE(MAX(version),0)::int AS v FROM schema_migrations");
  return rows[0]?.v ?? 0;
}

export async function migrateUp(db: DB, target = Infinity): Promise<number[]> {
  const applied: number[] = [];
  for (const m of migrations) {
    if (m.version > target) continue;
    await db.tx(async (q) => {
      // Lock FIRST: even CREATE TABLE IF NOT EXISTS races when two instances start at once.
      await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await ensureTable(q);
      if (m.version <= (await currentVersion(q))) return; // someone else applied it while we waited
      await q.exec(m.up);
      await q.query("INSERT INTO schema_migrations(version,name,applied_at) VALUES ($1,$2,$3)", [m.version, m.name, new Date().toISOString()]);
      applied.push(m.version);
    });
  }
  return applied;
}

export async function migrateDown(db: DB, steps = 1): Promise<number[]> {
  const reverted: number[] = [];
  for (let i = 0; i < steps; i++) {
    const done = await db.tx(async (q) => {
      // Lock FIRST: even CREATE TABLE IF NOT EXISTS races when two instances start at once.
      await q.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      await ensureTable(q);
      const v = await currentVersion(q);
      const m = migrations.find((x) => x.version === v);
      if (!m) return false;
      await q.exec(m.down);
      await q.query("DELETE FROM schema_migrations WHERE version = $1", [v]);
      reverted.push(v);
      return true;
    });
    if (!done) break;
  }
  return reverted;
}
