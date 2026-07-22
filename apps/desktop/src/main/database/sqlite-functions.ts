/**
 * User-defined SQLite functions registered on every data-database connection.
 *
 * Registration is additive: it only adds a callable name to the connection and
 * changes no existing query's behaviour. Both data-db connection paths —
 * `initDatabase` (the running app) and `createTestDataDb` (the desktop test
 * helper) — call `registerDataDbFunctions`, so a query written against these
 * functions behaves identically in production and under test.
 */

import type Database from 'better-sqlite3'

/**
 * Full-Unicode lowercase, as JavaScript's `String.prototype.toLowerCase` does it.
 *
 * SQLite's built-in `lower()` and the case-insensitive form of `LIKE` fold
 * ASCII only, so `LIKE '%ödeme%'` never matches "Ödeme Toplantısı". Registering
 * this lets a query opt into the same folding the renderer used to do in JS,
 * which matters for every non-ASCII locale the app ships.
 *
 * Non-string inputs (NULL, numbers, blobs) pass through untouched so the
 * function is safe to wrap around any column.
 */
export function registerDataDbFunctions(sqlite: Database.Database): void {
  sqlite.function('ulower', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : (value as null)
  )
}
