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
 * doc lacks always does. Every writer of a note file goes through here:
 * - The write-back records the bytes it writes before and after the write, so
 *   a crash between the file write and the hash update leaves them its own,
 *   and records the file when the doc already serializes to it.
 * - A seed, and the take of an owed file (`takeOwedFile`), record the bytes
 *   they built the doc from, over any older hash.
 * - Memry's other body writers (the note command, journal saves, appended
 *   blocks, task-line removal, version restore, a rename's link rewrites, the
 *   watcher's ingest) write the file, publish the baseline they find
 *   (`baselineBeforeFeed`), feed the doc, and record their bytes only once the
 *   doc holds them (`feedThenRecordBaseline`). A crash before the feed leaves
 *   their bytes an outside edit, which the next write-back feeds instead of
 *   writing the doc over them (#5304).
 * - A writer or reader that does not feed the doc (a metadata-only note or
 *   journal update, a rename that rewrites nothing, a remote journal apply,
 *   the ingest backfill) keeps the baseline it finds unless its bytes only
 *   change the frontmatter of the baseline (`baselineAfterWrite`,
 *   `baselineAfterRead`).
 * - A remote note create writes a new file with no baseline to keep, and the
 *   cache sync measures it.
 *
 * Any hash a writer moves clears a pending write (`updateNoteCache`,
 * `insertNoteCache`), so a stale pending hash never outlives the baseline it
 * was written against.
 *
 * @module sync/writeback-baseline
 */

import { getNoteCacheById, updateNoteCache } from '@main/database/queries/notes'
import type { getIndexDatabase } from '../database/client'
import { generateContentHash, parseNote } from '../vault/frontmatter'
import { flushProjectionEvents } from '../projections'

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

/**
 * The hash a writer publishes for bytes it wrote and has not fed to the doc
 * yet: the baseline it finds, or the written hash when the note has none.
 */
export function baselineBeforeFeed(indexDb: IndexDb, noteId: string, written: string): string {
  return baselineAfterRead(getNoteCacheById(indexDb, noteId), generateContentHash(written))
}

/**
 * Feeds the doc the bytes a writer wrote, then records them as the baseline
 * once the doc holds them. The cache sync's projection, which carries the
 * baseline the writer found, drains first so it cannot land over the record.
 * A baseline that moved meanwhile (a write-back pass) is left alone.
 */
export async function feedThenRecordBaseline(
  indexDb: IndexDb,
  noteId: string,
  written: string,
  feed: () => Promise<boolean>
): Promise<boolean> {
  const found = getNoteCacheById(indexDb, noteId)?.contentHash
  const fed = await feed()
  await flushProjectionEvents()
  if (fed && getNoteCacheById(indexDb, noteId)?.contentHash === found) {
    recordBaseline(indexDb, noteId, written)
  }
  return fed
}

/**
 * The hash a writer that does not feed the doc publishes for `written`, the
 * bytes it put over `previous`. The doc holds them when it held `previous`
 * and the body is unchanged; otherwise the baseline stays. A missing file
 * (`previous` null) is rewritten from the doc's side, as before.
 */
export function baselineAfterWrite(
  indexDb: IndexDb,
  noteId: string,
  previous: string | null,
  written: string
): string {
  const writtenHash = generateContentHash(written)
  const baseline = getNoteCacheById(indexDb, noteId)?.contentHash
  if (!baseline || previous === null || baseline === writtenHash) return writtenHash
  const held =
    generateContentHash(previous) === baseline &&
    parseNote(previous).content === parseNote(written).content
  return held ? writtenHash : baseline
}
