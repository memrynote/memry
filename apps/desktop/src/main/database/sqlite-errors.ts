import { toErrorCode } from '@memry/contracts/telemetry-api'

/**
 * True only for SQLite's corruption result codes.
 *
 * Covers the extended forms too: an fts5 index that fails its own checks
 * surfaces as `SQLITE_CORRUPT_VTAB` ("fts5: corruption found reading blob …"),
 * not the bare `SQLITE_CORRUPT`.
 *
 * Deliberately narrow. Every caller treats a positive as "this derived index is
 * unusable, drop and rebuild it", so a lock (`SQLITE_BUSY`), a readonly refusal
 * or a closed connection must never qualify — that would cost the user a full
 * reindex for a transient failure (#1585).
 *
 * Drizzle wraps driver errors in a `DrizzleError` and hangs the original on
 * `.cause`, so the code has to be read through the cause chain; `toErrorCode`
 * already walks it.
 */
export function isSqliteCorruptError(error: unknown): boolean {
  return toErrorCode(error).startsWith('SQLITE_CORRUPT')
}
