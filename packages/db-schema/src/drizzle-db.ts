import type { BaseSQLiteDatabase } from 'drizzle-orm/sqlite-core'
import type * as dataSchema from './data-schema'
import type * as indexSchema from './index-schema'

/**
 * The `run()` result surface shared sync/domain code relies on — the
 * structural intersection of better-sqlite3's `RunResult` and expo-sqlite's
 * `SQLiteRunResult`. Widening from `BetterSQLite3Database` to the
 * driver-agnostic `BaseSQLiteDatabase<'sync', …>` is what makes record-sync
 * services platform-free: both drivers are synchronous, so no call site gains
 * an `await`. Code that needs better-sqlite3's `lastInsertRowid` must keep the
 * concrete desktop type instead.
 */
export interface SyncRunResult {
  changes: number
}

export type DrizzleDb = BaseSQLiteDatabase<'sync', SyncRunResult, typeof dataSchema>
export type IndexDrizzleDb = BaseSQLiteDatabase<'sync', SyncRunResult, typeof indexSchema>
