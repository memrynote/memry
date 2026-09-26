import fs from 'fs'
import path from 'path'
import * as Y from 'yjs'
import {
  NOTE_BODY_FULL_STATE_PAYLOAD,
  type NoteBodyRow,
  type SyncQueueManager
} from '@memry/sync-client/queue'
import { createLogger } from '../lib/logger'
import { RateLimitError, SyncServerError } from './http-client'

const log = createLogger('NoteBodyOutbox')

// Minimum spacing between two flushes of one note (#2289): an update after a
// quiet window flushes at once, anything closer waits for one trailing flush.
// Not lowered to the record push's 300 ms: every CRDT push route shares one
// per-device `crdt_push` bucket (300/min) with snapshot pushes, and 300 ms
// would let two notes edited at once spend more than all of it.
const FLUSH_INTERVAL_MS = 1000
// Largest single merged update. Merged updates are pushed as one payload, so
// this keeps a long offline session from producing one blob the server cannot
// store in a D1 row (the push fn splits a batch across requests and falls back
// to a snapshot for anything still too large).
const MAX_MERGED_UPDATE_BYTES = 256 * 1024
// Largest raw payload one flush carries; the rest waits for the next window.
const MAX_FLUSH_PAYLOAD_BYTES = 512 * 1024
// Bounds the rows one flush reads (and the ids its ack deletes in one IN list).
const MAX_ROWS_PER_FLUSH = 500
// A deferred note waits 2 s, then twice as long after each deferral, up to a minute.
const DEFERRED_BACKOFF_BASE_MS = 2000
const DEFERRED_BACKOFF_MAX_MS = 60_000

/**
 * A flush that cannot succeed until something else changes (#2299): the
 * oversized-update snapshot fallback while the note is on the size-capped
 * update route (flagged unmerged, or refused) until its pull merges. The rows
 * stay queued and the note backs off instead of re-encoding every second.
 */
export class NoteBodyFlushDeferredError extends Error {}

export type NoteBodyPushFn = (noteId: string, updates: Uint8Array[]) => Promise<void>

/**
 * The note's whole doc state for a full-state row. `null` means the note no
 * longer syncs (deleted, local-only, binary) and its rows are dropped; a throw
 * keeps them for the next window.
 */
export type NoteBodyFullStateReader = (noteId: string) => Promise<Uint8Array | null>

export interface NoteBodyOutboxDeps {
  queue: SyncQueueManager
  push: NoteBodyPushFn
}

interface NoteBodyFlush {
  rowIds: string[]
  /** Built synchronously for update rows so a lone edit leaves on the leading edge. */
  updates: Uint8Array[] | null
}

/**
 * Durable CRDT body outbox (#2298): every local Yjs update is a `note_body` row
 * in `sync_queue` before this returns, so a crash, a quit while offline, or a
 * 401 pause loses nothing. Rows leave through the runtime's CRDT update push
 * (`/sync/crdt/updates`), merged per note at flush time, and are deleted by id
 * only once that push lands; rows enqueued meanwhile stay queued.
 */
export class NoteBodyOutbox {
  private running = false
  private paused = false
  private readFullState: NoteBodyFullStateReader | null = null
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastFlushStartedAt = new Map<string, number>()
  private flushingNotes = new Set<string>()
  /**
   * Epoch ms until which every flush is held back after a 429. Global, not per
   * note: every CRDT route spends one per-device `crdt_push` bucket and the
   * server counts the requests it answers with 429, so retrying another note
   * inside the window burns the same budget (#2293).
   */
  private rateLimitedUntil = 0
  /** Per note: consecutive deferrals and the time its next flush may start. */
  private deferredFlushes = new Map<string, { deferrals: number; until: number }>()
  /**
   * One full-state flush at a time, as the retired pending-note replay ran:
   * each merges the server's state before its push, and an upgrade can import
   * a whole backlog of them at once.
   */
  private fullStateFlushing = false

  constructor(private readonly deps: NoteBodyOutboxDeps) {}

  start(): void {
    this.running = true
    log.info('NoteBodyOutbox started')
    this.flushAll()
  }

  /** Rows stay in sync_queue; the next start flushes them. */
  stop(): void {
    this.running = false
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    log.info('NoteBodyOutbox stopped')
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    log.warn('NoteBodyOutbox paused — queued body updates flush on resume')
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    log.info('NoteBodyOutbox resumed')
    this.flushAll()
  }

  /**
   * Full-state rows need the sync engine to merge the server's state first, so
   * they wait until the runtime has one; update rows flush from `start()`.
   */
  enableFullStateFlush(readFullState: NoteBodyFullStateReader): void {
    this.readFullState = readFullState
    this.flushAll()
  }

  enqueue(noteId: string, update: Uint8Array): void {
    this.deps.queue.enqueueNoteBody(noteId, Buffer.from(update).toString('base64'))
    this.scheduleFlush(noteId)
  }

  enqueueFullState(noteId: string): void {
    this.deps.queue.enqueueNoteBody(noteId, NOTE_BODY_FULL_STATE_PAYLOAD)
    this.scheduleFlush(noteId)
  }

  /**
   * Forget a note's queued body without pushing it (local-only ON, purge). A
   * push already in flight cannot be recalled, but its ack deletes by row id
   * and its failure keeps nothing, so the rows cannot come back.
   */
  dropNote(noteId: string): void {
    this.deps.queue.removeNoteBody(noteId)
    const timer = this.flushTimers.get(noteId)
    if (timer) clearTimeout(timer)
    this.flushTimers.delete(noteId)
    this.lastFlushStartedAt.delete(noteId)
  }

  getOutstandingCount(): number {
    return this.deps.queue.countNoteBodyRows()
  }

  private flushAll(): void {
    for (const noteId of this.deps.queue.listNoteBodyNoteIds()) this.flushNote(noteId)
  }

  /**
   * Leading edge with a trailing guard, per note (#2289). A note with a push in
   * flight is skipped: its settle calls this again, so an update that landed
   * mid-push is flushed once after it and never through a re-armed timer.
   */
  private scheduleFlush(noteId: string): void {
    if (!this.running || this.paused) return
    if (this.flushingNotes.has(noteId) || this.flushTimers.has(noteId)) return
    if (!this.deps.queue.hasNoteBody(noteId)) return

    const now = Date.now()
    const sinceLastFlush = now - (this.lastFlushStartedAt.get(noteId) ?? Number.NEGATIVE_INFINITY)
    const heldUntil = this.heldUntil(noteId)
    if (sinceLastFlush > FLUSH_INTERVAL_MS && now >= heldUntil) {
      this.flushNote(noteId)
      return
    }
    const waitMs = Math.max(FLUSH_INTERVAL_MS - sinceLastFlush, heldUntil - now, 0)
    this.flushTimers.set(
      noteId,
      setTimeout(() => {
        this.flushTimers.delete(noteId)
        this.flushNote(noteId)
      }, waitMs)
    )
  }

  private heldUntil(noteId: string): number {
    return Math.max(this.rateLimitedUntil, this.deferredFlushes.get(noteId)?.until ?? 0)
  }

  private flushNote(noteId: string): void {
    if (!this.running || this.paused) return
    if (Date.now() < this.heldUntil(noteId)) {
      this.scheduleFlush(noteId)
      return
    }
    if (this.flushingNotes.has(noteId)) return

    const flush = this.planFlush(noteId)
    if (!flush) return
    const fullState = flush.updates === null
    if (fullState) this.fullStateFlushing = true

    this.flushingNotes.add(noteId)
    this.lastFlushStartedAt.set(noteId, Date.now())
    this.sendFlush(noteId, flush)
      .then(() => {
        this.deps.queue.removeNoteBodyRows(flush.rowIds)
        this.deferredFlushes.delete(noteId)
      })
      .catch((err) => this.onFlushFailed(noteId, flush.rowIds, err))
      .finally(() => {
        this.flushingNotes.delete(noteId)
        if (!fullState) return this.scheduleFlush(noteId)
        // Hand the full-state slot to the next note waiting for it.
        this.fullStateFlushing = false
        for (const next of this.deps.queue.listNoteBodyNoteIds()) this.scheduleFlush(next)
      })
  }

  /**
   * Pick the rows one flush sends. A full-state row covers every row read with
   * it: they were all applied to the local doc before they were enqueued, and
   * the state is encoded after this read. Update rows are taken in enqueue
   * order up to the payload budget, always at least one.
   */
  private planFlush(noteId: string): NoteBodyFlush | null {
    const rows = this.deps.queue.takeNoteBodyRows(noteId, MAX_ROWS_PER_FLUSH)
    if (rows.length === 0) return null
    if (rows.some((row) => row.payload === NOTE_BODY_FULL_STATE_PAYLOAD)) {
      if (!this.readFullState || this.fullStateFlushing) return null
      return { rowIds: rows.map((row) => row.id), updates: null }
    }

    const taken: NoteBodyRow[] = []
    const raw: Uint8Array[] = []
    let bytes = 0
    for (const row of rows) {
      const update = new Uint8Array(Buffer.from(row.payload, 'base64'))
      if (taken.length > 0 && bytes + update.byteLength > MAX_FLUSH_PAYLOAD_BYTES) break
      taken.push(row)
      raw.push(update)
      bytes += update.byteLength
    }
    return { rowIds: taken.map((row) => row.id), updates: mergeInOrder(noteId, raw) }
  }

  private async sendFlush(noteId: string, flush: NoteBodyFlush): Promise<void> {
    if (flush.updates) return this.deps.push(noteId, flush.updates)
    const state = await this.readFullState!(noteId)
    if (!state) return
    if (!this.running) throw new Error('NoteBodyOutbox stopped before the full state was pushed')
    await this.deps.push(noteId, [state])
  }

  private onFlushFailed(noteId: string, rowIds: string[], err: unknown): void {
    if (err instanceof NoteBodyFlushDeferredError) {
      const deferrals = (this.deferredFlushes.get(noteId)?.deferrals ?? 0) + 1
      const backoffMs = Math.min(
        DEFERRED_BACKOFF_MAX_MS,
        DEFERRED_BACKOFF_BASE_MS * 2 ** Math.min(deferrals - 1, 16)
      )
      this.deferredFlushes.set(noteId, { deferrals, until: Date.now() + backoffMs })
      log.warn('CRDT body flush deferred; backing the note off', { noteId, backoffMs })
      return
    }
    if (err instanceof RateLimitError) {
      this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + err.retryAfterMs)
      log.warn('429 received, holding CRDT body flushes until Retry-After', {
        noteId,
        backoffMs: err.retryAfterMs
      })
      return
    }
    if (!this.paused) log.error('Failed to push CRDT body updates', { noteId, error: err })
    // 401 keeps its rows: the push fn pauses the outbox and a token refresh
    // resumes it. Any other 4xx will not succeed on retry.
    const nonRetryable =
      err instanceof SyncServerError &&
      err.statusCode >= 400 &&
      err.statusCode < 500 &&
      err.statusCode !== 429 &&
      err.statusCode !== 401
    if (nonRetryable) this.deps.queue.removeNoteBodyRows(rowIds)
  }
}

/**
 * Pack consecutive updates into merged runs of at most MAX_MERGED_UPDATE_BYTES,
 * keeping enqueue order. `Y.mergeUpdates` is lossless; a merge that throws
 * sends the updates unmerged instead.
 */
function mergeInOrder(noteId: string, updates: Uint8Array[]): Uint8Array[] {
  const merged: Uint8Array[] = []
  let run: Uint8Array[] = []
  let runBytes = 0
  const closeRun = (): void => {
    if (run.length > 0) merged.push(run.length === 1 ? run[0] : Y.mergeUpdates(run))
    run = []
    runBytes = 0
  }
  try {
    for (const update of updates) {
      if (run.length > 0 && runBytes + update.byteLength > MAX_MERGED_UPDATE_BYTES) closeRun()
      run.push(update)
      runBytes += update.byteLength
    }
    closeRun()
    return merged
  } catch (err) {
    log.warn('Failed to merge queued CRDT updates, sending them unmerged', { noteId, error: err })
    return updates
  }
}

const LEGACY_PENDING_NOTES_FILE = 'crdt-pending-notes.json'

/**
 * One-shot upgrade import of the file-backed pending-note list that
 * `crdt-queue.ts` / `crdt-pending-notes.ts` kept in userData before #2298.
 * Every id becomes a full-state row, then the file is deleted. A crash in
 * between re-imports next start, and `enqueueNoteBody` keeps one full-state
 * row per note. Ids of other vaults or deleted notes resolve to "no longer
 * syncs" at flush time and are dropped there.
 */
export function importLegacyPendingCrdtNotes(queue: SyncQueueManager, userDataDir: string): number {
  const filePath = path.join(userDataDir, LEGACY_PENDING_NOTES_FILE)
  let raw: string
  try {
    raw = fs.readFileSync(filePath, 'utf8')
  } catch {
    return 0
  }
  const noteIds = parseLegacyPendingNoteIds(raw)
  for (const noteId of noteIds) queue.enqueueNoteBody(noteId, NOTE_BODY_FULL_STATE_PAYLOAD)
  fs.rmSync(filePath, { force: true })
  log.info('Imported pending CRDT notes from the retired file store', { count: noteIds.length })
  return noteIds.length
}

/**
 * The file was always a JSON array of note ids. A torn write still holds every
 * complete `"id"` token before the cut, and dropping a real id loses its edit
 * for good, so an unparsable file is salvaged token by token.
 */
function parseLegacyPendingNoteIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw)
    if (Array.isArray(parsed)) {
      return parsed.filter((id): id is string => typeof id === 'string' && id.length > 0)
    }
  } catch {
    // Salvaged below.
  }
  const ids = new Set<string>()
  for (const [token] of raw.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
    try {
      const value: unknown = JSON.parse(token)
      if (typeof value === 'string' && value.length > 0) ids.add(value)
    } catch {
      // Not a complete JSON string; the cut landed inside an escape.
    }
  }
  return Array.from(ids)
}
