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
 *   `recordDocFile` (#5698, the invariant and its three rules are stated
 *   there).
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

import * as Y from 'yjs'
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
  /**
   * Whether the store holds every update `doc`, an instance of the note's
   * doc, has made so far.
   */
  holdsDoc(noteId: string, doc: Y.Doc): boolean
  /**
   * Resolves once the store holds every update handed to it so far, storing
   * the whole doc again when the store missed one; rejects when a store fails.
   */
  whenPersisted(noteId: string): Promise<void>
  /**
   * Resolves once the store holds every update `doc` has made so far, however
   * late; never rejects, and never resolves once `doc` is not the note's open
   * doc without the store holding it.
   */
  whenStored(noteId: string, doc: Y.Doc): Promise<void>
}

/**
 * A doc instance, and the state of it that a file was serialized from: taken
 * when the conversion read the doc, so it names exactly what the bytes carry.
 */
export interface SerializedDoc {
  doc: Y.Doc
  state: Y.Snapshot
}

const encoded = (snapshot: Y.Snapshot): string =>
  Buffer.from(Y.encodeSnapshot(snapshot)).toString('base64')
const decoded = (part: string): Y.Snapshot => Y.decodeSnapshot(Buffer.from(part, 'base64'))

/**
 * The unstored mark of a write of `raw` serialized from `state`:
 * `unstored-file:<hash of raw>:<snapshot of raw>:<snapshot of the bytes under
 * content_hash>`, each snapshot a base64 Yjs snapshot (state vector and delete
 * set) of the doc state serialized into those bytes. Bytes the store holds
 * carry the empty snapshot, which every loaded doc covers. An empty last part:
 * the bytes under `content_hash` have no recorded snapshot (the row carried a
 * mark this build cannot read). A snapshot measures 25-32 KB of base64 on a
 * heavy doc; the mark stands only until the store holds the write.
 */
function unstoredMark(raw: string, state: Y.Snapshot, baseline: Y.Snapshot | null): string {
  return `${UNSTORED_FILE}:${generateContentHash(raw)}:${encoded(state)}:${baseline ? encoded(baseline) : ''}`
}

type UnstoredMark = { hash: string; snapshot: Y.Snapshot; baseline: Y.Snapshot | null }

/**
 * The parts of an unstored mark; null for a mark this build cannot read: the
 * bare `UNSTORED_FILE` of an earlier build of #5698, or the `<0|1>` flag of a
 * pre-release build of it, whose second part is no snapshot.
 */
function parseUnstoredMark(pending: string | null | undefined): UnstoredMark | null {
  const match = /^unstored-file:([^:]+):([A-Za-z0-9+/=]{4,}):([A-Za-z0-9+/=]{4,})?$/.exec(
    pending ?? ''
  )
  if (!match) return null
  try {
    return {
      hash: match[1],
      snapshot: decoded(match[2]),
      baseline: match[3] ? decoded(match[3]) : null
    }
  } catch (err) {
    log.warn('Could not read an unstored mark; the file is taken in', { err })
    return null
  }
}

/**
 * The snapshot of the bytes under the row's `content_hash`: empty when the
 * store holds them (no unstored mark), else the one the row's mark recorded
 * for them. Null when the row's mark cannot be read.
 */
function baselineSnapshot(row: Baseline | undefined): Y.Snapshot | null {
  if (!holdsUnstoredFile(row)) return Y.emptySnapshot
  const mark = parseUnstoredMark(row?.pendingWriteHash)
  if (!mark) return null
  return mark.hash === row?.contentHash ? mark.snapshot : mark.baseline
}

/** Whether `doc` holds every insert and delete of `marked`. */
function docCovers(doc: Y.Doc, marked: Y.Snapshot): boolean {
  const held = Y.snapshot(doc)
  for (const [client, clock] of marked.sv) {
    if ((held.sv.get(client) ?? 0) < clock) return false
  }
  for (const [client, items] of marked.ds.clients) {
    // Consecutive deleted structs merge into one item, so a range the doc
    // deleted sits inside a single item of its delete set.
    const deleted = held.ds.clients.get(client) ?? []
    for (const { clock, len } of items) {
      if (!deleted.some((d) => d.clock <= clock && clock + len <= d.clock + d.len)) return false
    }
  }
  return true
}

/**
 * The open-time decision for a file whose row carries an unstored mark: true
 * when the file must be taken into `doc`, the note's doc as loaded from the
 * store. A false answer settles the mark.
 *
 * INVARIANT (#5698): every file version the row can point at (the marked
 * write's hash, and `content_hash`) carries the snapshot of the doc state that
 * was serialized into those exact bytes (`unstoredMark`). The file is taken in
 * only when the loaded doc does not cover the snapshot recorded for the file's
 * hash: then it holds something the store lacks, and the caller keeps the doc
 * as a version first (`keepDocVersionBeforeIngest`). A file whose hash has no
 * recorded snapshot is an outside edit, taken in the same way, and so is a
 * mark this build cannot read. A covered file is the doc's own: it becomes the
 * baseline and the mark clears. So a file the store covers never beats a
 * stored edit made after it, whichever write left it on disk.
 */
export function takesUnstoredFile(
  indexDb: IndexDb,
  noteId: string,
  baseline: Baseline,
  raw: string,
  doc: Y.Doc
): boolean {
  const mark = parseUnstoredMark(baseline.pendingWriteHash)
  const onDisk = generateContentHash(raw)
  const written =
    mark &&
    (onDisk === mark.hash ? mark.snapshot : onDisk === baseline.contentHash ? mark.baseline : null)
  if (!written || !docCovers(doc, written)) return true
  recordBaseline(indexDb, noteId, raw)
  return false
}

/**
 * Records `raw`, a file the write-back wrote from `written` or found already
 * holding it, as the note's baseline.
 *
 * A file written from a doc the store may not hold yet is marked unstored, so
 * the next open can take in what the store lacks (#5698). The open decides by
 * what the write carried (`takesUnstoredFile` states the invariant). Three
 * rules keep the mark:
 * - Write-ahead mark. A write of a doc the store does not hold yet
 *   (`DocStore.holdsDoc`) marks the row before the file changes
 *   (`unstoredMark`), and records the file's hash in `content_hash` after (the
 *   watcher's rename match needs it). An open between the two, or a crash,
 *   finds the mark. A failed write whose file kept its bytes restores the row
 *   it found (`writeDocWithBaseline`).
 * - Instance-tied clear. Only a store of the doc instance that was
 *   serialized clears the mark (`DocStore.whenStored(noteId, doc)`, the
 *   provider's `storedWaiters`): its own stores, or the store of its whole
 *   state a close lands before destroying it. A later instance of the note,
 *   read from a store that may lack the file's bytes, never answers for it.
 *   After an ingest, the ingest's own store clears it
 *   (`ingestOutsideEditFirst`).
 * - Close before reopen. A close whose store does not hold the doc writes the
 *   note's armed pass from that doc inside the note's write-back turn before
 *   destroying it, and an open of the note waits for its close
 *   (`CrdtProvider.close`, `open`). So every open after such a doc finds the
 *   mark (`takeOfflineEdit`, `ingestOfflineEdit`), the first open of a
 *   session and every reopen in it alike.
 * A row whose mark moved on (a later write, an outside edit) is left alone. A session that ends first (a close whose store kept failing,
 * a quit cut short, a forced exit, a crash) leaves the mark for the next open.
 */
export function recordDocFile(
  indexDb: IndexDb,
  noteId: string,
  raw: string,
  { doc, state }: SerializedDoc,
  store: DocStore
): void {
  if (store.holdsDoc(noteId, doc)) {
    recordBaseline(indexDb, noteId, raw)
    return
  }
  // `content_hash` becomes `raw`'s, so both versions carry `raw`'s snapshot.
  const mark = unstoredMark(raw, state, state)
  updateNoteCache(indexDb, noteId, {
    contentHash: generateContentHash(raw),
    pendingWriteHash: mark
  })
  // Stores the whole doc again when the store missed an update.
  store.whenPersisted(noteId).catch((err: unknown) => {
    log.warn('The store has not confirmed a written file yet; its next open takes the file in', {
      noteId,
      err
    })
  })
  void store.whenStored(noteId, doc).then(() => {
    try {
      if (getNoteCacheById(indexDb, noteId)?.pendingWriteHash === mark) {
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
 * Writes `fileContent`, serialized from `written`, with `write`, and records it
 * through `recordDocFile`. A doc the store holds records its bytes on both
 * sides of the write, as `writeWithBaseline` does. A doc the store does not
 * hold marks the row before the write (`recordDocFile`, write-ahead mark). A
 * failed write re-reads the file with `read`: bytes it left unchanged get the
 * row's pending hash back as it found it, and any other bytes keep the mark,
 * since the write may have landed before it failed.
 */
export async function writeDocWithBaseline(
  indexDb: IndexDb,
  noteId: string,
  fileContent: string,
  file: { write: () => Promise<void>; read: () => Promise<string | null> },
  written: SerializedDoc,
  store: DocStore
): Promise<void> {
  if (store.holdsDoc(noteId, written.doc)) {
    await writeWithBaseline(indexDb, noteId, fileContent, file.write)
    return
  }
  const found = getNoteCacheById(indexDb, noteId)
  if (!found) {
    await file.write()
    return
  }
  const mark = markDocWrite(indexDb, noteId, fileContent, written, store)
  try {
    await file.write()
  } catch (err) {
    await dropMarkOfUnchangedFile(indexDb, noteId, found, mark, file.read)
    throw err
  }
  recordDocFile(indexDb, noteId, fileContent, written, store)
}

/** Gives a failed write's row back its pending hash when the file kept the bytes the row names. */
async function dropMarkOfUnchangedFile(
  indexDb: IndexDb,
  noteId: string,
  found: Baseline,
  mark: string,
  read: () => Promise<string | null>
): Promise<void> {
  try {
    const raw = await read()
    const row = getNoteCacheById(indexDb, noteId)
    if (raw === null || row?.pendingWriteHash !== mark) return
    if (generateContentHash(raw) !== row.contentHash || row.contentHash !== found.contentHash)
      return
    updateNoteCache(indexDb, noteId, { pendingWriteHash: found.pendingWriteHash ?? null })
  } catch (err) {
    log.warn('Could not re-read a file whose write failed; its mark stays', { noteId, err })
  }
}

/**
 * Marks the row before `raw`, serialized from `written`, is written to the
 * note's file: the pending hash when the store holds the doc, else an unstored
 * mark that keeps the snapshot of the bytes under `content_hash`
 * (`recordDocFile`, write-ahead mark). `recordDocFile` follows the write.
 * Resolves the pending hash it set.
 */
export function markDocWrite(
  indexDb: IndexDb,
  noteId: string,
  raw: string,
  written: SerializedDoc,
  store: DocStore
): string {
  const pendingWriteHash = store.holdsDoc(noteId, written.doc)
    ? generateContentHash(raw)
    : unstoredMark(raw, written.state, baselineSnapshot(getNoteCacheById(indexDb, noteId)))
  updateNoteCache(indexDb, noteId, { pendingWriteHash })
  return pendingWriteHash
}

/**
 * Whether the note's file may hold bytes its store lacks: every open decides
 * it (`takesUnstoredFile` states the invariant).
 */
export function holdsUnstoredFile(baseline: Baseline | undefined): boolean {
  return baseline?.pendingWriteHash?.startsWith(UNSTORED_FILE) === true
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
 * The hash of the bytes the row's pending write names: the marked write's
 * under an unstored mark, none under a mark this build cannot read.
 */
export function pendingWriteHashOf(pending: string | null | undefined): string | null {
  if (pending?.startsWith(UNSTORED_FILE)) return parseUnstoredMark(pending)?.hash ?? null
  return pending ?? null
}

/**
 * Whether `raw`, read from the note's file, holds an edit its doc lacks. Bytes
 * a write-back wrote before it stopped short of recording them are its own,
 * and become the baseline here. Under an unstored mark the store may lack
 * them, so the mark stays and only `content_hash` moves, as `recordDocFile`
 * leaves the row.
 */
export function isOutsideEdit(
  indexDb: IndexDb,
  noteId: string,
  baseline: Baseline,
  raw: string
): boolean {
  const onDisk = generateContentHash(raw)
  if (onDisk === baseline.contentHash) return false
  if (onDisk !== pendingWriteHashOf(baseline.pendingWriteHash)) return true
  if (holdsUnstoredFile(baseline)) updateNoteCache(indexDb, noteId, { contentHash: onDisk })
  else recordBaseline(indexDb, noteId, raw)
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
  written: SerializedDoc,
  store: DocStore
): void {
  if (baseline.contentHash === generateContentHash(raw) && !baseline.pendingWriteHash) return
  recordDocFile(indexDb, noteId, raw, written, store)
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
