/**
 * User-defined SQLite functions registered on every data and index connection.
 *
 * Registration is additive: it only adds a callable name to the connection and
 * changes no existing query's behaviour. Every connection path, `initDatabase`
 * and `initIndexDatabase` (the running app) and `createTestDataDb` and
 * `createTestIndexDb` (the desktop test helpers), calls
 * `registerSqliteFunctions`, so a query written against these functions behaves
 * identically in production and under test.
 */

import type Database from 'better-sqlite3'
import { foldTag } from '@memry/shared/tag-fold'

/**
 * - `ulower(text)`: full-Unicode lowercase, as JavaScript's
 *   `String.prototype.toLowerCase` does it. SQLite's built-in `lower()` and the
 *   case-insensitive form of `LIKE` fold ASCII only, so `LIKE '%ödeme%'` never
 *   matches "Ödeme Toplantısı".
 * - `tag_fold(text)`: a tag's identity (`foldTag`). The tag columns are
 *   `COLLATE NOCASE`, which folds ASCII only, so a query matching tags compares
 *   `tag_fold(column)` instead (`queries/tag-match.ts`).
 *
 * Non-string inputs (NULL, numbers, blobs) pass through untouched so each
 * function is safe to wrap around any column.
 */
export function registerSqliteFunctions(sqlite: Database.Database): void {
  sqlite.function('ulower', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? value.toLowerCase() : (value as null)
  )
  sqlite.function('tag_fold', { deterministic: true }, (value: unknown) =>
    typeof value === 'string' ? foldTag(value) : (value as null)
  )
}
