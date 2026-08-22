import Database from 'better-sqlite3'
import { readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

/**
 * A D1Database over real SQLite, provisioned by the real migration ledger.
 *
 * The compat suite exists to prove that a header-less request writes the same
 * bytes it always did. A hand-written `prepare()` fake cannot prove that: it
 * answers whatever the test taught it, so a wrong column list or a wrong bind
 * order passes. Running the actual SQL against the actual schema is the point.
 */
const migrationsDir = resolve(__dirname, '../../migrations')

const loadSchemaSql = (): string =>
  readdirSync(migrationsDir)
    .filter((file) => file.endsWith('.sql'))
    .sort()
    .map((file) => readFileSync(join(migrationsDir, file), 'utf8'))
    .join('\n')

type Row = Record<string, unknown>

// better-sqlite3 rejects typed arrays that are not Buffer and has no boolean
// type. Bindings are normalised on the way in only; rows come back untouched.
const toBinding = (value: unknown): unknown => {
  if (value instanceof ArrayBuffer) return Buffer.from(value)
  if (ArrayBuffer.isView(value)) {
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength)
  }
  if (typeof value === 'boolean') return value ? 1 : 0
  if (value === undefined) return null
  return value
}

/** The D1 statement surface plus a synchronous escape hatch for `batch()`. */
type SyncStatement = D1PreparedStatement & { runSync(): D1Result }

export interface SqliteD1 {
  db: D1Database
  raw: Database.Database
  close(): void
}

export const createSqliteD1 = (): SqliteD1 => {
  const sqlite = new Database(':memory:')
  sqlite.exec(loadSchemaSql())

  const prepare = (sql: string): D1PreparedStatement => {
    const statement = sqlite.prepare(sql)
    let bindings: unknown[] = []

    // `reader` is true for SELECT *and* for `INSERT/UPDATE ... RETURNING`, so
    // it is also the test for "this statement produces rows" -- which matters:
    // getNextCursor reads its new value out of a batched UPDATE ... RETURNING.
    const runSync = (): D1Result => {
      const rows = statement.reader ? (statement.all(...bindings) as Row[]) : []
      const changes = statement.reader ? rows.length : Number(statement.run(...bindings).changes)
      return {
        success: true,
        results: rows,
        meta: { changes, duration: 0, rows_read: 0, rows_written: changes }
      } as unknown as D1Result
    }

    const self = {
      bind: (...args: unknown[]) => {
        bindings = args.map(toBinding)
        return self
      },
      first: async (column?: string) => {
        if (!statement.reader) {
          statement.run(...bindings)
          return null
        }
        const row = statement.get(...bindings) as Row | undefined
        if (row === undefined) return null
        return column === undefined ? row : row[column]
      },
      run: async () => runSync(),
      runSync,
      all: async () => runSync(),
      raw: async () => (statement.reader ? statement.raw().all(...bindings) : [])
    } as unknown as SyncStatement

    return self
  }

  const db = {
    prepare,
    // D1 batches are atomic, and so is a better-sqlite3 transaction. The
    // transaction body must be synchronous, which is what `runSync` is for.
    batch: (statements: D1PreparedStatement[]) => {
      const execute = sqlite.transaction((stmts: SyncStatement[]) => stmts.map((s) => s.runSync()))
      return Promise.resolve(execute(statements as SyncStatement[]))
    },
    exec: async (sql: string) => {
      sqlite.exec(sql)
      return { count: 0, duration: 0 }
    }
  } as unknown as D1Database

  return { db, raw: sqlite, close: () => sqlite.close() }
}

/** In-memory R2. The compat suite asserts on D1 rows, not on blob bytes. */
export const createMemoryR2 = (): R2Bucket => {
  const objects = new Map<string, ArrayBuffer>()
  return {
    head: async (key: string) => (objects.has(key) ? ({ key } as R2Object) : null),
    put: async (key: string, value: ArrayBuffer) => {
      objects.set(key, value)
      return { key } as R2Object
    },
    get: async (key: string) => {
      const value = objects.get(key)
      return value ? ({ key, arrayBuffer: async () => value } as unknown as R2ObjectBody) : null
    },
    delete: async (key: string | string[]) => {
      for (const k of Array.isArray(key) ? key : [key]) objects.delete(k)
    },
    list: async () => ({ objects: [], truncated: false }) as unknown as R2Objects
  } as unknown as R2Bucket
}
