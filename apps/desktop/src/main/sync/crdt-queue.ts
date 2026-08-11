import * as Y from 'yjs'
import { createLogger } from '../lib/logger'
import { SyncServerError } from './http-client'

const log = createLogger('CrdtUpdateQueue')

const FLUSH_INTERVAL_MS = 1000
const MAX_BATCH_SIZE = 50
// Largest single merged update produced by coalescing. Merged updates are
// pushed as one payload, so this keeps a long offline session from producing
// one blob the server rejects (the push fn caps a batch at ~900KB base64).
const MAX_MERGED_UPDATE_BYTES = 256 * 1024
// Largest raw payload a single flush may carry, for the same reason: after
// coalescing a batch of 50 entries could otherwise be tens of megabytes.
const MAX_FLUSH_PAYLOAD_BYTES = 512 * 1024

interface BufferedUpdate {
  noteId: string
  rawUpdate: Uint8Array
  timestamp: number
}

export interface CrdtUpdateQueueOptions {
  /**
   * Called synchronously from `stop()` with the notes whose updates could not
   * be flushed before shutdown. Must persist them durably — see
   * `recordPendingCrdtNotes`.
   */
  persistUnflushed?: (noteIds: string[]) => void
}

export class CrdtUpdateQueue {
  private buffers = new Map<string, BufferedUpdate[]>()
  private flushTimer: ReturnType<typeof setInterval> | null = null
  private flushingNotes = new Set<string>()
  private pushFn: ((noteId: string, updates: Uint8Array[]) => Promise<void>) | null = null
  private paused = false

  constructor(private readonly options: CrdtUpdateQueueOptions = {}) {}

  start(pushFn: (noteId: string, updates: Uint8Array[]) => Promise<void>): void {
    this.pushFn = pushFn
    this.flushTimer = setInterval(() => {
      this.flushAll()
    }, FLUSH_INTERVAL_MS)
    log.info('CrdtUpdateQueue started')
  }

  stop(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer)
      this.flushTimer = null
    }
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

    if (buffer.length < MAX_BATCH_SIZE) return

    this.flushNote(noteId)

    // A paused, offline or mid-flight queue keeps the buffer. Merge it in place
    // so an offline session costs the size of the edit instead of one retained
    // Uint8Array per keystroke. Yjs update merging is lossless — nothing is
    // evicted, the same operations are simply carried in fewer arrays.
    const remaining = this.buffers.get(noteId)
    if (remaining && remaining.length >= MAX_BATCH_SIZE) {
      this.coalesce(noteId, remaining)
    }
  }

  getPendingCount(): number {
    let count = 0
    for (const buffer of this.buffers.values()) {
      count += buffer.length
    }
    return count
  }

  getOutstandingCount(): number {
    return this.getPendingCount() + this.flushingNotes.size
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
        rawUpdate: run.length === 1 ? run[0]! : Y.mergeUpdates(run),
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

  private flushNote(noteId: string): void {
    if (this.paused) return
    if (this.flushingNotes.has(noteId)) return

    const buffer = this.buffers.get(noteId)
    if (!buffer || buffer.length === 0) return

    const updates = this.takeBatch(buffer)
    if (buffer.length === 0) this.buffers.delete(noteId)

    if (!this.pushFn) {
      log.warn('No push function registered, dropping updates', { noteId, count: updates.length })
      return
    }

    this.flushingNotes.add(noteId)
    this.pushFn(
      noteId,
      updates.map((u) => u.rawUpdate)
    )
      .catch((err) => {
        if (!this.paused) {
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

        let existing = this.buffers.get(noteId)
        if (!existing) {
          existing = []
          this.buffers.set(noteId, existing)
        }
        existing.unshift(...updates)
      })
      .finally(() => {
        this.flushingNotes.delete(noteId)
      })
  }
}
