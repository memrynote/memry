/**
 * The write-back's outside-edit baseline: the bytes of a note file that its
 * doc already holds (#5292, #5296).
 *
 * The write-back treats a note file as edited outside Memry when the file's
 * bytes are not the baseline, and feeds them into the doc before it writes.
 * The baseline is `note_cache.content_hash`, plus `pending_write_hash` while a
 * write-back's own bytes are on their way to disk.
 *
 * Invariant: the baseline only names bytes the doc holds, so the bytes Memry
 * wrote or read into the doc never read as an outside edit, and an edit the
 * doc lacks always does. These writers go through here:
 * - The write-back records the bytes it writes before and after the write, so
 *   a crash between the file write and the hash update leaves them its own,
 *   and records the file when the doc already serializes to it.
 * - A seed records the bytes it built the doc from, over any older hash.
 * - A reader that does not feed the doc (the ingest backfill) keeps the
 *   baseline it finds.
 *
 * Memry's other body writers (the note command, appended blocks, version
 * restore, a rename's link rewrites, the watcher's ingest) still write the
 * file, move the hash through the cache sync, and then feed the doc. A crash
 * between the hash and the feed leaves the hash past bytes the doc lacks.
 * Routing them through here is #5304. Any hash they move clears a pending
 * write (`updateNoteCache`, `insertNoteCache`), so a stale pending hash never
 * outlives the baseline it was written against.
 *
 * @module sync/writeback-baseline
 */

import { getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import type { getIndexDatabase } from '../database/client'
import { generateContentHash } from '../vault/frontmatter'

type IndexDb = ReturnType<typeof getIndexDatabase>
type Baseline = { contentHash?: string | null; pendingWriteHash?: string | null }

/** Records `raw` as bytes the note's doc holds. */
export function recordBaseline(indexDb: IndexDb, noteId: string, raw: string): void {
  updateNoteCache(indexDb, noteId, {
    contentHash: generateContentHash(raw),
    pendingWriteHash: null
  })
}

/**
 * Writes `fileContent` with `write`, recording it as the baseline on both
 * sides of the write. A note the index does not hold yet records nothing: its
 * projection is late, and the write-back's own sync to the cache fills it in.
 */
export async function writeWithBaseline(
  indexDb: IndexDb,
  noteId: string,
  fileContent: string,
  write: () => Promise<void>
): Promise<void> {
  const indexed = getNoteCacheById(indexDb, noteId) !== undefined
  if (indexed) {
    updateNoteCache(indexDb, noteId, { pendingWriteHash: generateContentHash(fileContent) })
  }
  await write()
  if (indexed) recordBaseline(indexDb, noteId, fileContent)
}

/**
 * Whether `raw`, read from the note's file, holds an edit its doc lacks. Bytes
 * a write-back wrote before it stopped short of recording them are its own,
 * and become the baseline here.
 */
export function isOutsideEdit(
  indexDb: IndexDb,
  noteId: string,
  baseline: Baseline,
  raw: string
): boolean {
  const onDisk = generateContentHash(raw)
  if (onDisk === baseline.contentHash) return false
  if (onDisk !== baseline.pendingWriteHash) return true
  recordBaseline(indexDb, noteId, raw)
  return false
}

/**
 * Records the file a write-back left alone because the doc already serializes
 * to it: those bytes are the doc's, whatever the baseline said before.
 */
export function recordUnchangedFile(
  indexDb: IndexDb,
  noteId: string,
  baseline: Baseline,
  raw: string
): void {
  if (baseline.contentHash === generateContentHash(raw) && !baseline.pendingWriteHash) return
  recordBaseline(indexDb, noteId, raw)
}

/**
 * The hash a reader that does not feed the doc (the ingest backfill after a
 * rename) records for the bytes it measured: the baseline it found, or the
 * measured hash when the note has none yet. Moving a baseline past bytes the
 * doc never took hides them from the write-back, which then writes the doc
 * over them.
 */
export function baselineAfterRead(baseline: Baseline | undefined, measuredHash: string): string {
  return baseline?.contentHash ?? measuredHash
}
