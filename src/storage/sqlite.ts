import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname } from "node:path";
import { resolveInsideRoot } from "./workspace.js";

export interface SqlStatement {
  run(params?: unknown[]): boolean;
  bind(params?: unknown[]): boolean;
  step(): boolean;
  getAsObject(): Record<string, unknown>;
  reset(): boolean;
  free(): boolean;
}

export interface SqlDatabase {
  run(sql: string, params?: unknown[]): SqlDatabase;
  prepare(sql: string): SqlStatement;
  export(): Uint8Array;
  close(): void;
}

interface SqlModule {
  Database: new (data?: Uint8Array) => SqlDatabase;
}

export interface OpenedSqlDatabase {
  db: SqlDatabase;
  dbPath: string;
  flush(): void;
  close(): void;
}

const require = createRequire(import.meta.url);

let sqlModulePromise: Promise<SqlModule> | undefined;

function initSql(): Promise<SqlModule> {
  if (!sqlModulePromise) {
    const init = require("sql.js-fts5") as (cfg?: unknown) => Promise<SqlModule>;
    const wasmPath = require.resolve("sql.js-fts5/dist/sql-wasm.wasm");
    sqlModulePromise = init({ wasmBinary: readFileSync(wasmPath) });
  }
  return sqlModulePromise;
}

interface SharedDbEntry {
  db: SqlDatabase;
  refs: number;
}

// Every handle to the same file must share ONE in-memory instance: sql.js
// instances are independent full copies of the file and flush() rewrites the
// whole file from that copy, so two live handles (the background ingest
// worker plus any tool call — all in this same process) would silently drop
// each other's writes, last write wins. Entries stay cached after the last
// close so the next tool call reuses the loaded copy instead of re-reading
// the file; flush()/close() persist to disk at every boundary.
const sharedDbs = new Map<string, Promise<SharedDbEntry>>();

function acquireShared(guardedDbPath: string): Promise<SharedDbEntry> {
  let entry = sharedDbs.get(guardedDbPath);
  if (!entry) {
    entry = initSql().then((SQL) => ({
      db: existsSync(guardedDbPath)
        ? new SQL.Database(readFileSync(guardedDbPath))
        : new SQL.Database(),
      refs: 0,
    }));
    sharedDbs.set(guardedDbPath, entry);
  }
  return entry;
}

export async function openSqlDatabase(
  dbPath: string,
  authorizedRoot: string,
): Promise<OpenedSqlDatabase> {
  const guardedDbPath = resolveInsideRoot(authorizedRoot, dbPath);
  mkdirSync(dirname(guardedDbPath), { recursive: true });
  const entry = await acquireShared(guardedDbPath);
  entry.refs++;
  let closed = false;
  const persist = () => {
    writeFileSync(guardedDbPath, Buffer.from(entry.db.export()));
  };

  return {
    db: entry.db,
    dbPath: guardedDbPath,
    flush() {
      if (!closed) persist();
    },
    close() {
      if (closed) return;
      closed = true;
      persist();
      entry.refs--;
    },
  };
}
