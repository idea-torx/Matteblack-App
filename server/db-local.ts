/**
 * Embedded-Postgres pool shim backed by PGlite (@electric-sql/pglite).
 *
 * PGlite is a full Postgres 16 compiled to WASM that runs in-process and
 * persists to a local directory — no server, no DATABASE_URL, no native build.
 * Because it speaks real Postgres, the app's ~1400-line Postgres-specific
 * schema (JSONB, TEXT[] arrays, plpgsql triggers, gen_random_uuid(), DO $$
 * blocks, partial indexes) runs unchanged.
 *
 * This module exposes an object shaped like a `pg.Pool` — `query()`,
 * `connect()`, `end()` — so every existing `pool.query(...)` / `pool.connect()`
 * call site keeps working.
 *
 * Concurrency model: PGlite is a SINGLE connection and serialises queries
 * through its own internal queue, so we run everything directly against it and
 * do NOT add an external mutex. That matters because the codebase has code
 * paths that call `pool.query(...)` while a `pool.connect()` client is still
 * checked out mid-transaction (e.g. db.ts writes a run-once marker via
 * pool.query() before releasing the migration client). With real `pg` those
 * land on different pooled connections; with one shared connection an external
 * "hold the lock until release()" mutex would self-deadlock. So `connect()`
 * hands back a thin client over the same connection and `release()` is a no-op.
 *
 * Caveat (accepted for a single-user desktop app): because there is only one
 * connection, a `pool.query()` issued by a *concurrent* async flow while
 * another flow has an open BEGIN…COMMIT will execute inside that transaction.
 * In practice local usage is effectively single-threaded per request, so this
 * does not bite; see CONVERSION.md for the fuller discussion.
 *
 * Routing rule: parametrised queries use PGlite's extended-protocol `.query()`;
 * parameter-less strings (including the multi-statement DDL in initDB and the
 * BEGIN/COMMIT control statements) go through simple-protocol `.exec()`, which
 * is the only path that accepts multiple statements and dollar-quoted plpgsql
 * bodies.
 */
import type { PGlite } from "@electric-sql/pglite";
import { PG_DATA_DIR, ensureDataDir } from "./config/runtime.js";

interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
}

function shapeExecResult(results: Array<{ rows?: unknown[]; affectedRows?: number }>): QueryResult {
  // `.exec()` returns one result per statement; callers care about the last.
  const last = results[results.length - 1] || { rows: [] };
  const rows = (last.rows as Record<string, unknown>[]) ?? [];
  return { rows, rowCount: last.affectedRows ?? rows.length };
}

function shapeQueryResult(result: { rows: unknown[]; affectedRows?: number }): QueryResult {
  const rows = (result.rows as Record<string, unknown>[]) ?? [];
  return { rows, rowCount: result.affectedRows ?? rows.length };
}

async function runOn(db: PGlite, sql: string, params?: unknown[]): Promise<QueryResult> {
  if (params && params.length > 0) {
    const r = await db.query(sql, params as unknown[]);
    return shapeQueryResult(r as { rows: unknown[]; affectedRows?: number });
  }
  const results = await db.exec(sql);
  return shapeExecResult(results as Array<{ rows?: unknown[]; affectedRows?: number }>);
}

class LocalPoolClient {
  constructor(private db: PGlite) {}
  query(sql: string, params?: unknown[]): Promise<QueryResult> {
    return runOn(this.db, sql, params);
  }
  // Single shared connection — nothing to return to a pool.
  release(): void { /* no-op */ }
}

class LocalPool {
  private dbPromise: Promise<PGlite>;

  constructor() {
    ensureDataDir();
    this.dbPromise = (async () => {
      const { PGlite } = await import("@electric-sql/pglite");
      const db = new PGlite(PG_DATA_DIR);
      await db.waitReady;
      console.log(`[db] PGlite ready at ${PG_DATA_DIR}`);
      return db;
    })();
  }

  async query(sql: string, params?: unknown[]): Promise<QueryResult> {
    const db = await this.dbPromise;
    return runOn(db, sql, params);
  }

  async connect(): Promise<LocalPoolClient> {
    const db = await this.dbPromise;
    return new LocalPoolClient(db);
  }

  async end(): Promise<void> {
    const db = await this.dbPromise;
    await (db as unknown as { close: () => Promise<void> }).close();
  }
}

export function createLocalPool(): LocalPool {
  return new LocalPool();
}

export type { LocalPool };
