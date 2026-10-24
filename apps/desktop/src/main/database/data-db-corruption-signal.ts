import type Database from 'better-sqlite3'

import { isSqliteCorruptError } from './sqlite-errors'

type CorruptionListener = (dbPath: string, error: unknown) => void

let listener: CorruptionListener | null = null

/**
 * Subscribe to SQLITE_CORRUPT raised by any statement on the data.db
 * connection mid-session (#3247). The open-time quick_check only sees damage
 * present at open; this catches pages that go bad, or are first read, later.
 * One listener: the vault owns the recovery decision.
 */
export function onDataDbCorruption(next: CorruptionListener | null): void {
  listener = next
}

function report(db: Database.Database, error: unknown): void {
  if (isSqliteCorruptError(error)) listener?.(db.name, error)
}

function guard<A extends unknown[], R>(
  db: Database.Database,
  fn: (...args: A) => R
): (...args: A) => R {
  return (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      report(db, error)
      throw error
    }
  }
}

function instrumentStatement(db: Database.Database, stmt: Database.Statement): Database.Statement {
  stmt.run = guard(db, stmt.run.bind(stmt))
  stmt.get = guard(db, stmt.get.bind(stmt))
  stmt.all = guard(db, stmt.all.bind(stmt))
  const iterate = stmt.iterate.bind(stmt)
  stmt.iterate = function* (...args: unknown[]) {
    try {
      yield* iterate(...args)
    } catch (error) {
      report(db, error)
      throw error
    }
  } as Database.Statement['iterate']
  return stmt
}

/**
 * Route every statement on the data.db connection through the corruption
 * check. Errors are rethrown unchanged; the listener only observes them.
 */
export function instrumentDataDbConnection(db: Database.Database): void {
  const prepare = db.prepare.bind(db)
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- better-sqlite3 returns unknown rows; row shape is fixed by this SQL
  db.prepare = ((source: string) =>
    instrumentStatement(db, prepare(source))) as Database.Database['prepare']
  db.exec = guard(db, db.exec.bind(db))
  db.pragma = guard(db, db.pragma.bind(db))
}
