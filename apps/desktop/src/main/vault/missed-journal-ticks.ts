/**
 * The bytes the vault open's replay last ticked a journal day for (#5757).
 *
 * The replay ticks a day whose file differs from its baseline (#5752). The
 * ingest that follows moves the baseline only when the doc takes the edit. A
 * day never opened in Memry has an empty doc that declines it until the day's
 * first open seeds from the file, so without this record every vault open
 * ticked and pushed the same edit again, re-clocking its tags over peer tag
 * edits not pulled yet.
 *
 * Keyed per day in `sync_state` (device-local, additive: older builds never
 * read it). The value pairs the baseline with the file's hash, so the same
 * bytes written again after the baseline moved still tick.
 *
 * @module vault/missed-journal-ticks
 */

import { eq } from 'drizzle-orm'
import { syncState } from '@memry/db-schema/schema/sync-state'
import type { DataDb } from '../database/types'
import { generateContentHash } from './frontmatter'

type Baseline = { contentHash?: string | null }

const keyOf = (noteId: string): string => `journalReplayTick:${noteId}`
const valueOf = (baseline: Baseline, raw: string): string =>
  `${baseline.contentHash ?? ''}:${generateContentHash(raw)}`

export function wasTicked(db: DataDb, noteId: string, baseline: Baseline, raw: string): boolean {
  const row = db
    .select({ value: syncState.value })
    .from(syncState)
    .where(eq(syncState.key, keyOf(noteId)))
    .get()
  return row?.value === valueOf(baseline, raw)
}

export function recordTick(db: DataDb, noteId: string, baseline: Baseline, raw: string): void {
  const value = valueOf(baseline, raw)
  const updatedAt = new Date()
  db.insert(syncState)
    .values({ key: keyOf(noteId), value, updatedAt })
    .onConflictDoUpdate({ target: syncState.key, set: { value, updatedAt } })
    .run()
}
