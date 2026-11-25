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
 * - The write-back writes the live doc, which may hold updates the store has
 *   not confirmed, so it records its bytes through `writeDocWithBaseline` and
 *   `recordDocFile` (#5698, the invariant is stated there).
 * - A seed, and the take of an owed file (`takeOwedFile`), record the bytes
 *   they built the doc from, over any older hash.
 * - Memry's other body writers (the note command, journal saves, appended
 *   blocks, task-line removal, version restore, a move's ref rewrite, a
 *   rename's link rewrites, the agent's journal update) feed the doc first,
 *   wait for the store to hold the update, and then write the file through
 *   `writeWithBaseline` (`landBodyEdit`, D-DOC-FIRST). A locked note is refused before the feed.
 *   A write-back pass that converted the doc before such a feed writes the
 *   older body after the writer's file, so it arms another pass when the doc
 *   moved meanwhile.
 *   A crash after the feed, or a failed file write, leaves the doc ahead of
 *   the file with the baseline kept, and the write-back writes it; a crash after
 *   the write leaves the pending hash naming Memry's own bytes. A store that
 *   fails fails the writer, with no file written. A doc that declines the
 *   feed (closed and empty, owed, large-file) gets the file written with the
 *   baseline kept: the empty doc's next open seeds from the file, the owed
 *   doc takes it after its merge (`takeOwedFile`), and a large-file note has
 *   no doc.
 * - The watcher's ingest of an outside edit drains the cache sync's projection,
 *   feeds the doc, and records the bytes once the doc holds them
 *   (`ingestOutsideEdit`).
 * - A writer or reader that does not feed the doc (a metadata-only note or
 *   journal update, a rename that rewrites nothing, a remote note rename or
 *   frontmatter rewrite, a remote journal apply, a journal create over an
 *   existing day file, the ingest backfill) keeps the baseline it finds unless
 *   its bytes only change the frontmatter of the baseline
 *   (`baselineAfterWrite`, `baselineAfterRead`).
 * - Exceptions, with no baseline to keep or move: a remote or local note create
 *   (`createNote`) writes a new file the cache sync measures; an import copies
 *   new files the watcher indexes (`copyImportedFile`); the agent's journal
 *   create writes a day file only where none exists (`journal-handles.ts`);
 *   the root-properties migration rewrites only frontmatter and re-reads the
 *   files it wrote (`indexVault` forcePaths); a vault lock writes back the
 *   locked text its doc holds.
 *
 * Any hash a writer moves clears a pending write (`updateNoteCache`,
 * `insertNoteCache`), so a stale pending hash never outlives the baseline it
 * was written against.
 *
 * @module sync/writeback-baseline
 */

import { getNoteCacheById, UNSTORED_FILE, updateNoteCache } from '@main/database/queries/notes'
import type { getIndexDatabase } from '../database/client'
import { generateContentHash, parseNote } from '../vault/frontmatter'
import { flushProjectionEvents } from '../projections'
import { createLogger } from '../lib/logger'
import { assertNoteWritable } from '../vault-locks/registry'
import { NoteError, NoteErrorCode } from '../lib/errors'
import { crdtWriteback } from './crdt-writeback-port'

const log = createLogger('WritebackBaseline')

type IndexDb = ReturnType<typeof getIndexDatabase>
type Baseline = { contentHash?: string | null; pendingWriteHash?: string | null }

/** Records `raw` as bytes the note's doc holds. */
export function recordBaseline(indexDb: IndexDb, noteId: string, raw: string): void {
  updateNoteCache(indexDb, noteId, {
    contentHash: generateContentHash(raw),
    pendingWriteHash: null
  })
}

/** The CRDT store's side of a note, as the write-back's baseline needs it. */
export interface DocStore {
  /** An update of the note is on its way to the store, or the store missed one. */
  isStoring(noteId: string): boolean
  /**
   * Resolves once the store holds every update handed to it so far, storing
   * the whole doc again when the store missed one; rejects when a store fails.
   */
  whenPersisted(noteId: string): Promise<void>
  /**
   * Resolves once the store holds every update the live doc has made so far,
   * however late; never rejects, and never resolves once that doc closed
   * without the store holding them.
   */
  whenStored(noteId: string): Promise<void>
}

/**
 * Records `raw`, a file the write-back wrote from the live doc or found
 * already holding it, as the note's baseline.
 *
 * INVARIANT (#5698): while a note's row carries `UNSTORED_FILE`, its file is
 * the note's source of truth.
 * - Set: the write-back wrote the file from a live doc whose updates the store
 *   has not confirmed (`DocStore.isStoring`). The row keeps the file's real
 *   hash in `content_hash` (the watcher's rename match needs it) and the
 *   marker in `pending_write_hash`.
 * - Read: every open of the note's doc, the first of a session or a reopen in
 *   the same session (after a close, an eviction, a vault switch), takes the
 *   file into the doc before any edit reaches it (`takeOfflineEdit`,
 *   `ingestOfflineEdit`). The doc it read from the store may lack the file's
 *   bytes, and a write-back of it would put that older body over the file.
 * - Cleared: only once a store of a doc that holds the file's bytes lands.
 *   Here, by `whenStored` of the doc instance that wrote the file: its own
 *   stores, or the store of its whole state retried before it is destroyed. A
 *   later instance never answers for it (`ActiveDoc.storedWaiters`). After an
 *   ingest, by the ingest's own store (`ingestOutsideEditFirst`).
 * A row whose `content_hash` moved past `raw` (a later write, an outside edit)
 * is left alone. A session that ends first (a close whose store kept failing,
 * a quit cut short, a forced exit, a crash) leaves the marker for the next
 * open. A marker that outlives a recovery costs that open a re-ingest, which
 * keeps the doc as a version first (`crdt-writeback-ingest.ts`).
 */
export function recordDocFile(
  indexDb: IndexDb,
  noteId: string,
  raw: string,
  store: DocStore
): void {
  if (!store.isStoring(noteId)) {
    recordBaseline(indexDb, noteId, raw)
    return
  }
  updateNoteCache(indexDb, noteId, {
    contentHash: generateContentHash(raw),
    pendingWriteHash: UNSTORED_FILE
  })
  const hash = generateContentHash(raw)
  // Stores the whole doc again when the store missed an update.
  store.whenPersisted(noteId).catch((err: unknown) => {
    log.warn('The store has not confirmed a written file yet; its next open takes the file in', {
      noteId,
      err
    })
  })
  void store.whenStored(noteId).then(() => {
    try {
      const row = getNoteCacheById(indexDb, noteId)
      if (holdsUnstoredFile(row) && row?.contentHash === hash) {
        updateNoteCache(indexDb, noteId, { pendingWriteHash: null })
      }
    } catch (err) {
      log.warn('Could not record a stored file; its next open takes the file in again', {
        noteId,
        err
      })
    }
  })
}

/**
 * Writes `fileContent`, the live doc's bytes, with `write`, and records it
 * through `recordDocFile`. A doc the store holds records its bytes on both
 * sides of the write, as `writeWithBaseline` does. A doc still storing claims
 * no bytes before the write: a crash after it leaves the file an outside edit.
 * A failed write keeps the mark the file carries: the file still holds bytes
 * the store may lack, and it stays the source of truth (`recordDocFile`).
 */
export async function writeDocWithBaseline(
  indexDb: IndexDb,
  noteId: string,
  fileContent: string,
  write: () => Promise<void>,
  store: DocStore
): Promise<void> {
  if (!store.isStoring(noteId)) {
    await writeWithBaseline(indexDb, noteId, fileContent, write)
    return
  }
  const indexed = getNoteCacheById(indexDb, noteId) !== undefined
  await write()
  if (indexed) recordDocFile(indexDb, noteId, fileContent, store)
}

/**
 * Whether the note's file holds bytes its store may lack: the file is the
 * source of truth, and every open takes it in (`recordDocFile` states the
 * invariant).
 */
export function holdsUnstoredFile(baseline: Baseline | undefined): boolean {
  return baseline?.pendingWriteHash === UNSTORED_FILE
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
 * to it: those bytes are the doc's, whatever the baseline said before, once
 * the store holds them (`recordDocFile`).
 */
export function recordUnchangedFile(
  indexDb: IndexDb,
  noteId: string,
  baseline: Baseline,
  raw: string,
  store: DocStore
): void {
  if (baseline.contentHash === generateContentHash(raw) && !baseline.pendingWriteHash) return
  recordDocFile(indexDb, noteId, raw, store)
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
 * The hash a writer publishes for bytes its doc does not hold yet: the
 * baseline it finds, or the written hash when the note has none.
 */
export function baselineBeforeFeed(indexDb: IndexDb, noteId: string, written: string): string {
  return baselineAfterRead(getNoteCacheById(indexDb, noteId), generateContentHash(written))
}

/**
 * Lands Memry's own change of a note body (D-DOC-FIRST): `feed` puts it in the
 * doc, then `write` puts `fileContent` on disk through `writeWithBaseline`.
 * Resolves the hash the cache sync publishes.
 *
 * - A locked note throws before the feed, so no caller puts an edit in a
 *   locked note's doc.
 * - A feed that rejects (the store failed) throws, with no file written and
 *   the baseline kept: the caller keeps its copy of the edit.
 * - A feed that declines writes the file and keeps the baseline.
 * - A failed file write after the feed keeps the baseline, and the write-back
 *   writes the file from the doc, which owns the body; a caller that swallows
 *   the error still gets a file that converges. The writer then throws: it
 *   often carries frontmatter the doc does not hold, which only the caller's
 *   retry lands.
 * - `appends`: the edit adds to the body, so a caller's retry would add it
 *   twice. A failed file write after the feed then resolves instead.
 * - A lock refusal of the write throws with no write-back.
 */
export async function landBodyEdit(
  indexDb: IndexDb,
  noteId: string,
  fileContent: string,
  steps: {
    /** Vault-relative, so the lock check does not depend on the index row. */
    notePath: string
    feed: () => Promise<boolean>
    write: () => Promise<void>
    appends?: boolean
  }
): Promise<string> {
  const fed = await feedBodyEdit(noteId, steps.notePath, steps.feed)
  return writeFedBodyEdit(indexDb, noteId, fileContent, fed, steps)
}

/**
 * `landBodyEdit`'s first half, for a writer that writes in the note's
 * write-back turn: the feed can wait on the store, so it runs before the turn
 * and the writer reads the note's path again in it (#5690).
 */
export async function feedBodyEdit(
  noteId: string,
  notePath: string,
  feed: () => Promise<boolean>
): Promise<boolean> {
  assertNoteWritable(noteId, notePath)
  return feed().catch((err: unknown) => {
    log.error('Could not store a body change in its doc; nothing was written', { noteId, err })
    throw err
  })
}

/** `landBodyEdit`'s second half: writes the file once `feedBodyEdit` resolved `fed`. */
export async function writeFedBodyEdit(
  indexDb: IndexDb,
  noteId: string,
  fileContent: string,
  fed: boolean,
  steps: { write: () => Promise<void>; appends?: boolean }
): Promise<string> {
  if (!fed) {
    await steps.write()
    return baselineBeforeFeed(indexDb, noteId, fileContent)
  }
  try {
    await writeWithBaseline(indexDb, noteId, fileContent, steps.write)
  } catch (err) {
    if (err instanceof NoteError && err.code === NoteErrorCode.READ_ONLY) throw err
    log.error('The doc holds a body change its file write missed; the write-back writes it', {
      noteId,
      err
    })
    crdtWriteback().retryWriteback(noteId)
    if (!steps.appends) throw err
    return baselineBeforeFeed(indexDb, noteId, fileContent)
  }
  return generateContentHash(fileContent)
}

/**
 * The watcher's ingest of an outside edit already on disk: the cache sync's
 * projection, which carries the baseline the watcher found, drains first, then
 * the doc takes `raw`, and `raw` becomes the baseline once the doc holds it. A
 * baseline that moved meanwhile (a write-back pass) is left alone.
 */
export async function ingestOutsideEdit(
  indexDb: IndexDb,
  noteId: string,
  raw: string,
  feed: () => Promise<boolean>
): Promise<boolean> {
  await flushProjectionEvents()
  const found = getNoteCacheById(indexDb, noteId)?.contentHash
  const fed = await feed()
  if (fed && getNoteCacheById(indexDb, noteId)?.contentHash === found) {
    recordBaseline(indexDb, noteId, raw)
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
