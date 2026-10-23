import { z } from 'zod'
import type { ReadwiseErrorKind, ReadwiseRunCounts } from '@memry/contracts/import-channels'
import { readwiseHighlights } from '@memry/db-schema/schema/readwise-highlights'
import { deleteSetting, getSetting, setSetting } from '../database/queries/settings'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database/types'

/**
 * Device-local Readwise run state (#1411, D7/D8). It lives in the `settings`
 * table under its own keys. `SyncedSettingsSchema` never names them and the
 * settings sync payload is one `synced_settings` row, so none of it syncs.
 */
const CURSOR_KEY = 'readwise.cursor'
const READER_CURSOR_KEY = 'readwise.readerCursor'
const RETRY_KEY = 'readwise.retryList'
const FULL_PASS_KEY = 'readwise.fullPass'
const LAST_RUN_KEY = 'readwise.lastRun'
const LAST_FULL_READ_KEY = 'readwise.lastFullRead'
const ERROR_TOAST_KEY = 'readwise.errorToastShown'
const HIGHLIGHT_INDEX_KEY = 'readwise.highlightIndex'
const JOURNAL_PENDING_KEY = 'readwise.journalPending'

const log = createLogger('ReadwiseState')

export interface RetryEntry {
  readwiseBookId: number
  reason: string
  attempts: number
}

const RetryListSchema = z.array(
  z.object({
    readwiseBookId: z.number().int(),
    reason: z.string(),
    attempts: z.number().int().min(1)
  })
)

/** Newest highlight `updated_at` applied by the last completed run, minus one second (Readwise time). */
export function getCursor(db: DataDb): string | null {
  return getSetting(db, CURSOR_KEY)
}

export function setCursor(db: DataDb, cursor: string): void {
  setSetting(db, CURSOR_KEY, cursor)
}

export function clearCursor(db: DataDb): void {
  deleteSetting(db, CURSOR_KEY)
}

/** Newest Reader document `updated_at` the last Reader pass saw, minus one second (Reader time). Null: the next pass lists everything. */
export function getReaderCursor(db: DataDb): string | null {
  return getSetting(db, READER_CURSOR_KEY)
}

export function setReaderCursor(db: DataDb, cursor: string): void {
  setSetting(db, READER_CURSOR_KEY, cursor)
}

export function getRetryList(db: DataDb): RetryEntry[] {
  const raw = getSetting(db, RETRY_KEY)
  if (raw === null) return []
  try {
    return RetryListSchema.parse(JSON.parse(raw))
  } catch (err) {
    // The list only says which books to refetch, so a bad value costs one
    // missed retry, not data. The next export pass picks the book up again.
    log.warn('Dropping unreadable Readwise retry list', err)
    return []
  }
}

/** Adds the book, or bumps its attempt count and reason when it is already listed. */
export function addRetry(db: DataDb, readwiseBookId: number, reason: string): RetryEntry[] {
  const list = getRetryList(db)
  const existing = list.find((entry) => entry.readwiseBookId === readwiseBookId)
  if (existing) {
    existing.reason = reason
    existing.attempts += 1
  } else {
    list.push({ readwiseBookId, reason, attempts: 1 })
  }
  setSetting(db, RETRY_KEY, JSON.stringify(list))
  return list
}

export function removeRetry(db: DataDb, readwiseBookId: number): RetryEntry[] {
  const list = getRetryList(db).filter((entry) => entry.readwiseBookId !== readwiseBookId)
  if (list.length === 0) deleteSetting(db, RETRY_KEY)
  else setSetting(db, RETRY_KEY, JSON.stringify(list))
  return list
}

export function getFullPassPending(db: DataDb): boolean {
  return getSetting(db, FULL_PASS_KEY) === 'true'
}

export function setFullPassPending(db: DataDb, pending: boolean): void {
  if (pending) setSetting(db, FULL_PASS_KEY, 'true')
  else deleteSetting(db, FULL_PASS_KEY)
}

/** When a run last read the whole export (no `updatedAfter`), as an ISO time on this device's clock. */
export function getLastFullRead(db: DataDb): string | null {
  return getSetting(db, LAST_FULL_READ_KEY)
}

export function setLastFullRead(db: DataDb, at: string): void {
  setSetting(db, LAST_FULL_READ_KEY, at)
}

export type AttentionKind = Extract<ReadwiseErrorKind, 'invalid-token' | 'subscription-expired'>

export interface LastRun {
  /** ISO time the run finished on this device. */
  at: string
  /** Set when the run failed in a way the user must fix, such as a revoked token. */
  needsAttention: boolean
  /** Which error parked the run. Absent in a value an older build wrote: read as `invalid-token`. */
  attention?: AttentionKind
  /** The completed run's counts (#1418). Absent in a value an older build wrote. */
  counts?: ReadwiseRunCounts
}

const CountsSchema = z.object({
  books: z.number(),
  added: z.number(),
  updated: z.number(),
  appended: z.number(),
  deferred: z.number(),
  failed: z.number(),
  highlights: z.number()
})

const LastRunSchema = z.object({
  at: z.string(),
  needsAttention: z.boolean(),
  attention: z.enum(['invalid-token', 'subscription-expired']).optional(),
  counts: CountsSchema.optional()
})

export function getLastRun(db: DataDb): LastRun | null {
  const raw = getSetting(db, LAST_RUN_KEY)
  if (raw === null) return null
  try {
    return LastRunSchema.parse(JSON.parse(raw))
  } catch (err) {
    // Display state only: the row and panel show no last run until the next one.
    log.warn('Dropping unreadable Readwise last run', err)
    return null
  }
}

export function setLastRun(db: DataDb, run: LastRun): void {
  setSetting(db, LAST_RUN_KEY, JSON.stringify(run))
  // The error is fixed: the next episode may show its toast again (D19).
  if (!run.needsAttention) deleteSetting(db, ERROR_TOAST_KEY)
}

/**
 * The error toast's once-per-episode flag (D19), device-local. True when this
 * call is the first of the episode, and it records that the toast was shown.
 * Cleared by `setLastRun` once the error is fixed.
 */
export function claimErrorToast(db: DataDb): boolean {
  if (!getLastRun(db)?.needsAttention) return false
  if (getSetting(db, ERROR_TOAST_KEY) !== null) return false
  setSetting(db, ERROR_TOAST_KEY, 'true')
  return true
}

/**
 * Whether a full export has filled the highlight index (#3476). Until it has,
 * the next run reads the whole export and reports no arrivals, so the first run
 * after the index shipped never writes the old highlights into the journal.
 */
export function isHighlightIndexReady(db: DataDb): boolean {
  return getSetting(db, HIGHLIGHT_INDEX_KEY) === 'ready'
}

export function setHighlightIndexReady(db: DataDb): void {
  setSetting(db, HIGHLIGHT_INDEX_KEY, 'ready')
}

/** Journal days still owed a write, as `date -> book id -> arrivals` (#3476). */
export type JournalPending = Record<string, Record<string, number>>

const JournalPendingSchema = z.record(z.string(), z.record(z.string(), z.number().int().min(1)))

export function getJournalPending(db: DataDb): JournalPending {
  const raw = getSetting(db, JOURNAL_PENDING_KEY)
  if (raw === null) return {}
  try {
    return JournalPendingSchema.parse(JSON.parse(raw))
  } catch (err) {
    // A bad value costs the pending journal lines of this device, never a note.
    log.warn('Dropping unreadable Readwise journal pending list', err)
    return {}
  }
}

export function setJournalPending(db: DataDb, pending: JournalPending): void {
  if (Object.keys(pending).length === 0) deleteSetting(db, JOURNAL_PENDING_KEY)
  else setSetting(db, JOURNAL_PENDING_KEY, JSON.stringify(pending))
}

/** Forgets the connection's run state, so a reconnect starts from a full export. */
export function clearRunState(db: DataDb): void {
  deleteSetting(db, CURSOR_KEY)
  deleteSetting(db, READER_CURSOR_KEY)
  deleteSetting(db, RETRY_KEY)
  deleteSetting(db, FULL_PASS_KEY)
  deleteSetting(db, LAST_RUN_KEY)
  deleteSetting(db, LAST_FULL_READ_KEY)
  deleteSetting(db, ERROR_TOAST_KEY)
  deleteSetting(db, HIGHLIGHT_INDEX_KEY)
  deleteSetting(db, JOURNAL_PENDING_KEY)
  // The index is derived from the export: the next full read fills it again.
  db.delete(readwiseHighlights).run()
}
