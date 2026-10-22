import { z } from 'zod'
import { deleteSetting, getSetting, setSetting } from '../database/queries/settings'
import { createLogger } from '../lib/logger'
import type { DataDb } from '../database/types'

/**
 * Device-local Readwise run state (#1411, D7/D8). It lives in the `settings`
 * table under its own keys. `SyncedSettingsSchema` never names them and the
 * settings sync payload is one `synced_settings` row, so none of it syncs.
 */
const CURSOR_KEY = 'readwise.cursor'
const RETRY_KEY = 'readwise.retryList'
const FULL_PASS_KEY = 'readwise.fullPass'

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
