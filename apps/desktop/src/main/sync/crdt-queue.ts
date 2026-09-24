import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { RateLimitError, SyncServerError } from './http-client'

const log = createLogger('CrdtUpdateQueue')

// Minimum spacing between two flushes of one note (#2289): an update after a
// quiet window flushes at once, anything closer waits for one trailing flush.
// Not lowered to the record push's 300 ms: every CRDT push route shares one
// per-device `crdt_push` bucket (300/min) with snapshot pushes, and 300 ms
// would let two notes edited at once spend more than all of it.
const FLUSH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50
// Largest single merged update produced by coalescing. Merged updates are
// pushed as one payload, so this keeps a long offline session from producing
// one blob the server cannot store in a D1 row (the push fn splits a batch
// across requests and falls back to a snapshot for anything still too large).
const MAX_MERGED_UPDATE_BYTES = 256 * 1024
// Largest raw payload a single flush may carry, for the same reason: after
// coalescing a batch of 50 entries could otherwise be tens of megabytes.
const MAX_FLUSH_PAYLOAD_BYTES = 512 * 1024
// Ceiling on everything buffered across every note. The caps above are all
// per note; the map itself keeps one live buffer per note touched since the
// queue was paused, so a long offline session still grows by note count.
const MAX_TOTAL_BUFFERED_BYTES = 32 * 1024 * 1024
// Release down to here once the ceiling is crossed, so one sweep buys room for
// a while instead of running on every subsequent enqueue.
const TOTAL_BUFFER_LOW_WATER_BYTES = 24 * 1024 * 1024
// When a sweep cannot get back under the ceiling — because releasing would
// mean losing updates — wait for this much extra growth before trying again.
const BUDGET_RECHECK_STEP_BYTES = 4 * 1024 * 1024

interface BufferedUpdate {
  noteId: string
  rawUpdate: Uint8Array
  timestamp: number
}

function bytesOf(entries: readonly BufferedUpdate[]): number {
  let total = 0
  for (const entry of entries) total += entry.rawUpdate.byteLength
  return total
}

export interface CrdtUpdateQueueOptions {
  /**
   * Called synchronously from `stop()` with the notes whose updates could not
   * be flushed before shutdown, and from the total-buffer budget sweep with the
   * notes whose payloads are about to be released. Must persist them durably —
   * see `recordPendingCrdtNotes`.
   */
  persistUnflushed?: (noteIds: string[]) => void
}

export class CrdtUpdateQueue {
  private buffers = new Map<string, BufferedUpdate[]>()
  private running = false
  private flushTimers = new Map<string, ReturnType<typeof setTimeout>>()
  private lastFlushStartedAt = new Map<string, number>()
  private flushingNotes = new Set<string>()
  /** Notes `dropNote` reached mid-push; their batch must not be re-buffered. */
  private droppedInFlight = new Set<string>()
  private pushFn: ((noteId: string, updates: Uint8Array[]) => Promise<void>) | null = null
  private paused = false
  /**
   * Epoch ms until which every flush is held back after a 429.
   *
   * Without this the queue answered a 429 by putting the batch straight back
   * and retrying on the next 1s tick, per note. Seeding a vault pushes more
   * CRDT updates than the server's per-device window allows, so the queue sat
   * in a hot loop: hundreds of 429s a minute, every one of them counting
   * against the very window it was waiting on. UploadQueue and DownloadQueue
   * already back off globally on 429 honouring Retry-After; this is the same
   * rule for body sync.
   */
  private rateLimitedUntil = 0
  private bufferedBytes = 0
  private nextBudgetSweepBytes = MAX_TOTAL_BUFFERED_BYTES

  constructor(private readonly options: CrdtUpdateQueueOptions = {}) {}

  start(pushFn: (noteId: string, updates: Uint8Array[]) => Promise<void>): void {
    this.pushFn = pushFn
    this.running = true
    log.info('CrdtUpdateQueue started')
    this.flushAll()
  }

  stop(): void {
    this.running = false
    for (const timer of this.flushTimers.values()) clearTimeout(timer)
    this.flushTimers.clear()
    this.flushAll()

    // flushAll() no-ops while paused (offline / 401 / quota) and its pushes are
    // async, so anything still buffered or in flight here dies with the
    // process. The local Y.Doc already holds this content, so recording the
    // note ids durably is enough: the next start re-pushes their full state.
    const unflushed = new Set(this.flushingNotes)
    for (const [noteId, buffer] of this.buffers) {
      if (buffer.length > 0) unflushed.add(noteId)
    }
    if (unflushed.size > 0) {
      log.warn('Recording notes with unflushed CRDT updates for replay on next start', {
        noteCount: unflushed.size
      })
      this.options.persistUnflushed?.(Array.from(unflushed))
    }

    log.info('CrdtUpdateQueue stopped')
  }

  pause(): void {
    if (this.paused) return
    this.paused = true
    log.warn('CrdtUpdateQueue paused — buffered updates will flush on resume')
  }

  resume(): void {
    if (!this.paused) return
    this.paused = false
    log.info('CrdtUpdateQueue resumed')
    this.flushAll()
  }

  enqueue(noteId: string, rawUpdate: Uint8Array): void {
    let buffer = this.buffers.get(noteId)
    if (!buffer) {
      buffer = []
      this.buffers.set(noteId, buffer)
    }
    buffer.push({ noteId, rawUpdate, timestamp: Date.now() })
    this.bufferedBytes += rawUpdate.byteLength

    if (buffer.length >= MAX_BATCH_SIZE) {
      this.flushNote(noteId)

      // A paused, offline or mid-flight queue keeps the buffer. Merge it in
      // place so an offline session costs the size of the edit instead of one
      // retained Uint8Array per keystroke. Yjs update merging is lossless —
      // nothing is evicted, the same operations are simply carried in fewer
      // arrays.
      const remaining = this.buffers.get(noteId)
      if (remaining && remaining.length >= MAX_BATCH_SIZE) {
        this.coalesce(noteId, remaining)
      }
    }
    this.scheduleFlush(noteId)

    // Every cap above is per note; this one bounds the map as a whole.
    if (this.bufferedBytes >= this.nextBudgetSweepBytes) {
      this.enforceTotalBudget()
    }
  }

  /**
   * Forget everything buffered for a note, without pushing it.
   *
   * The one caller is `CrdtProvider.setNoteLocalOnly` going ON: the note has
   * just been told never to leave this device, and the guard that enforces that
   * sits at `onDocUpdate`, i.e. at enqueue time. Anything still buffered is
   * already past that guard and would go out on the note's next flush.
   *
   * Dropping loses nothing. Every update here is also in the local CRDT store,
   * which is what the doc is rebuilt from; the queue only ever held a copy bound
   * for the server, and there is no longer a server for this note.
   *
   * A push already in flight cannot be recalled, but its failure path must not
   * put the batch back — a 429 or a 5xx re-buffers, and the next flush would
   * then push a note that stopped syncing seconds ago. `flushingNotes` is what
   * distinguishes "in flight" from "settled", and the entry is cleared when the
   * push settles.
   */
  dropNote(noteId: string): void {
    const buffer = this.buffers.get(noteId)
    if (buffer) {
      this.bufferedBytes -= bytesOf(buffer)
      this.buffers.delete(noteId)
    }
    if (this.flushingNotes.has(noteId)) this.droppedInFlight.add(noteId)
    const timer = this.flushTimers.get(noteId)
    if (timer) clearTimeout(timer)
    this.flushTimers.delete(noteId)
    this.lastFlushStartedAt.delete(noteId)
  }

  getPendingCount(): number {
    let count = 0
    for (const buffer of this.buffers.values()) {
      count += buffer.length
    }
    return count
  }

  /** Raw bytes held across every note's buffer. */
  getPendingBytes(): number {
    return this.bufferedBytes
  }

  getOutstandingCount(): number {
    return this.getPendingCount() + this.flushingNotes.size
  }

  /**
   * Bound the whole map rather than one note at a time.
   *
   * Tries every lossless option first — flush what the server will take, then
   * merge each buffer in place — and only then releases the oldest notes'
   * payloads. A release is not a drop: the note ids go to the durable pending
   * store first, and `drainPendingCrdtNotes` re-pushes each note's full doc
   * state (which strictly supersedes the buffered updates) on the next
   * reconnect or start. If there is no durable store to release into, or
   * recording fails, the memory is kept instead.
   */
  private enforceTotalBudget(): void {
    // Free when running (takeBatch removes the bytes synchronously) and a
    // no-op while paused, which is the case this budget actually exists for.
    this.flushAll()

    for (const [noteId, buffer] of this.buffers) {
      if (buffer.length > 1) this.coalesce(noteId, buffer)
    }

    if (this.bufferedBytes <= MAX_TOTAL_BUFFERED_BYTES) {
      this.nextBudgetSweepBytes = MAX_TOTAL_BUFFERED_BYTES
      return
    }

    const persistUnflushed = this.options.persistUnflushed
    if (!persistUnflushed) {
      log.warn('CRDT buffers are over budget but there is no durable store to release into', {
        bufferedBytes: this.bufferedBytes,
        noteCount: this.buffers.size
      })
      this.nextBudgetSweepBytes = this.bufferedBytes + BUDGET_RECHECK_STEP_BYTES
      return
    }

    // Oldest buffered edit first: the note the user is typing in right now is
    // the newest, and the oldest is the one least likely to still be active.
    const oldestFirst = Array.from(this.buffers.entries()).sort(
      (a, b) => (a[1][0]?.timestamp ?? 0) - (b[1][0]?.timestamp ?? 0)
    )
    const release: string[] = []
    let releasedBytes = 0
    for (const [noteId, buffer] of oldestFirst) {
      if (this.bufferedBytes - releasedBytes <= TOTAL_BUFFER_LOW_WATER_BYTES) break
      release.push(noteId)
      releasedBytes += bytesOf(buffer)
    }

    try {
      // Durable first — the ids have to survive before the payloads go.
      if (release.length > 0) persistUnflushed(release)
    } catch (err) {
      log.error('Failed to record CRDT notes for replay, keeping their updates buffered', {
        noteCount: release.length,
        error: err
      })
      this.nextBudgetSweepBytes = this.bufferedBytes + BUDGET_RECHECK_STEP_BYTES
      return
    }

    for (const noteId of release) this.buffers.delete(noteId)
    this.bufferedBytes -= releasedBytes
    this.nextBudgetSweepBytes = MAX_TOTAL_BUFFERED_BYTES
    log.warn('CRDT buffers over budget — released the oldest notes for full-state replay', {
      noteCount: release.length,
      releasedBytes,
      bufferedBytes: this.bufferedBytes
    })
  }

  /**
   * Replace a note's buffer with the same operations packed into size-bounded
   * merged updates. Never drops an update: `Y.mergeUpdates` is lossless, and a
   * merge failure leaves the buffer exactly as it was.
   */
  private coalesce(noteId: string, buffer: BufferedUpdate[]): void {
    const merged: BufferedUpdate[] = []
    let run: Uint8Array[] = []
    let runBytes = 0
    let runTimestamp = 0

    const closeRun = (): void => {
      if (run.length === 0) return
      merged.push({
        noteId,
        rawUpdate: run.length === 1 ? run[0] : Y.mergeUpdates(run),
        timestamp: runTimestamp
      })
      run = []
      runBytes = 0
    }

    try {
      for (const entry of buffer) {
        if (run.length > 0 && runBytes + entry.rawUpdate.byteLength > MAX_MERGED_UPDATE_BYTES) {
          closeRun()
        }
        if (run.length === 0) runTimestamp = entry.timestamp
        run.push(entry.rawUpdate)
        runBytes += entry.rawUpdate.byteLength
      }
      closeRun()
    } catch (err) {
      log.warn('Failed to merge buffered CRDT updates, keeping them unmerged', {
        noteId,
        error: err
      })
      return
    }

    if (merged.length >= buffer.length) return
    this.bufferedBytes += bytesOf(merged) - bytesOf(buffer)
    buffer.splice(0, buffer.length, ...merged)
  }

  /**
   * Take the head of a buffer, bounded by both entry count and raw bytes so a
   * merged backlog cannot produce a payload the server rejects. Always takes at
   * least one entry, so an oversized update can never wedge the queue.
   */
  private takeBatch(buffer: BufferedUpdate[]): BufferedUpdate[] {
    let count = 0
    let bytes = 0
    for (const entry of buffer) {
      if (count >= MAX_BATCH_SIZE) break
      if (count > 0 && bytes + entry.rawUpdate.byteLength > MAX_FLUSH_PAYLOAD_BYTES) break
      count++
      bytes += entry.rawUpdate.byteLength
    }
    return buffer.splice(0, count)
  }

  private flushAll(): void {
    for (const noteId of this.buffers.keys()) {
      this.flushNote(noteId)
    }
  }

  /**
   * Leading edge with a trailing guard, per note (#2289). A note with a push in
   * flight is skipped: its settle calls this again, so an update that landed
   * mid-push is flushed once after it and never through a re-armed timer.
   */
  private scheduleFlush(noteId: string): void {
    if (!this.running || this.paused) return
    if (this.flushingNotes.has(noteId) || this.flushTimers.has(noteId)) return
    if (!this.buffers.get(noteId)?.length) return

    const now = Date.now()
    const sinceLastFlush = now - (this.lastFlushStartedAt.get(noteId) ?? Number.NEGATIVE_INFINITY)
    if (sinceLastFlush > FLUSH_INTERVAL_MS && now >= this.rateLimitedUntil) {
      this.flushNote(noteId)
      return
    }
    const waitMs = Math.max(FLUSH_INTERVAL_MS - sinceLastFlush, this.rateLimitedUntil - now, 0)
    this.flushTimers.set(
      noteId,
      setTimeout(() => {
        this.flushTimers.delete(noteId)
        this.flushNote(noteId)
      }, waitMs)
    )
  }

  private flushNote(noteId: string): void {
    if (this.paused) return
    // Global, not per note: the server's bucket is per device, so retrying a
    // different note inside the window just burns the same budget.
    if (Date.now() < this.rateLimitedUntil) {
      this.scheduleFlush(noteId)
      return
    }
    if (this.flushingNotes.has(noteId)) return

    const buffer = this.buffers.get(noteId)
    if (!buffer || buffer.length === 0) return

    const updates = this.takeBatch(buffer)
    this.bufferedBytes -= bytesOf(updates)
    if (buffer.length === 0) this.buffers.delete(noteId)

    if (!this.pushFn) {
      log.warn('No push function registered, dropping updates', { noteId, count: updates.length })
      return
    }

    this.flushingNotes.add(noteId)
    this.lastFlushStartedAt.set(noteId, Date.now())
    this.pushFn(
      noteId,
      updates.map((u) => u.rawUpdate)
    )
      .catch((err) => {
        if (err instanceof RateLimitError) {
          this.rateLimitedUntil = Math.max(this.rateLimitedUntil, Date.now() + err.retryAfterMs)
          log.warn('429 received, holding CRDT flushes until Retry-After', {
            noteId,
            backoffMs: err.retryAfterMs
          })
        } else if (!this.paused) {
          log.error('Failed to push CRDT updates', { noteId, error: err })
        }
        // 401 stays buffered: the push fn pauses the queue and a successful
        // token refresh resumes it, so the batch retries instead of dropping.
        const nonRetryable =
          err instanceof SyncServerError &&
          err.statusCode >= 400 &&
          err.statusCode < 500 &&
          err.statusCode !== 429 &&
          err.statusCode !== 401
        if (nonRetryable) return
        // Dropped while this push was in flight — see `dropNote`.
        if (this.droppedInFlight.has(noteId)) return

        let existing = this.buffers.get(noteId)
        if (!existing) {
          existing = []
          this.buffers.set(noteId, existing)
        }
        existing.unshift(...updates)
        this.bufferedBytes += bytesOf(updates)
      })
      .finally(() => {
        this.flushingNotes.delete(noteId)
        this.droppedInFlight.delete(noteId)
        this.scheduleFlush(noteId)
      })
  }
}
