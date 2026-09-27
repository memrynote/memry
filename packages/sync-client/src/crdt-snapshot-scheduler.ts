import { createLogger } from './logging'

const log = createLogger('CrdtSnapshotScheduler')

/**
 * Quiet period after the last incremental batch before the full-document
 * snapshot is worth re-uploading.
 */
export const SNAPSHOT_QUIET_MS = 30_000

/**
 * Ceiling on how long an uninterrupted typing run may defer a snapshot, so the
 * server still gets a periodic compaction point instead of an unbounded tail of
 * incremental updates.
 */
export const SNAPSHOT_MAX_WAIT_MS = 120_000

/**
 * How long a note that came due waits for others before the batch is sent.
 *
 * Notes written together come due together: a 200-note import is 200 quiet
 * periods ending within a few seconds of each other. Sent one request per note
 * that burst spent the device's whole CRDT push budget (300/min, shared with
 * `/sync/crdt/updates`) and drew 429s. Sent as one call, the provider packs
 * them into `/sync/crdt/snapshot/batch` requests of up to 50 notes. A snapshot
 * is only a compaction point, so a couple of seconds more costs nothing.
 */
export const SNAPSHOT_BATCH_WINDOW_MS = 2_000

interface PendingSnapshot {
  timer: ReturnType<typeof setTimeout>
  firstRequestedAt: number
}

export interface CrdtSnapshotSchedulerOptions {
  quietMs?: number
  maxWaitMs?: number
  batchWindowMs?: number
  now?: () => number
}

/**
 * Coalesces snapshot pushes for a note.
 *
 * A snapshot is a full `Y.encodeStateAsUpdate` + encrypt + upload, so its cost
 * scales with document size rather than edit size. Requesting one after every
 * incremental batch turns continuous typing into a permanent CPU and bandwidth
 * burn. Deferring is safe: the incremental updates already reached the server
 * (and the local CRDT store) before a snapshot is ever requested, so the
 * snapshot only moves the server's compaction watermark forward.
 */
export class CrdtSnapshotScheduler {
  private pending = new Map<string, PendingSnapshot>()
  /** Came due, waiting for the batch window to close. */
  private due = new Set<string>()
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private inFlight = new Set<string>()
  private stopped = false
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly batchWindowMs: number
  private readonly now: () => number

  /** `pushFn` receives every note that came due in one batch window. */
  constructor(
    private readonly pushFn: (noteIds: string[]) => Promise<unknown>,
    options: CrdtSnapshotSchedulerOptions = {}
  ) {
    this.quietMs = options.quietMs ?? SNAPSHOT_QUIET_MS
    this.maxWaitMs = options.maxWaitMs ?? SNAPSHOT_MAX_WAIT_MS
    this.batchWindowMs = options.batchWindowMs ?? SNAPSHOT_BATCH_WINDOW_MS
    this.now = options.now ?? Date.now
  }

  request(noteId: string): void {
    if (this.stopped) return

    const existing = this.pending.get(noteId)
    const firstRequestedAt = existing?.firstRequestedAt ?? this.now()
    if (existing) clearTimeout(existing.timer)

    const remainingMaxWait = firstRequestedAt + this.maxWaitMs - this.now()
    const delay = Math.max(0, Math.min(this.quietMs, remainingMaxWait))

    const timer = unrefTimer(setTimeout(() => this.fire(noteId), delay))
    this.pending.set(noteId, { timer, firstRequestedAt })
  }

  stop(): void {
    this.stopped = true
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.batchTimer = null
    this.due.clear()
  }

  /** Notes whose snapshot has not been handed to `pushFn` yet. */
  getPendingNoteIds(): string[] {
    return [...new Set([...this.pending.keys(), ...this.due])]
  }

  private fire(noteId: string): void {
    this.pending.delete(noteId)
    if (this.stopped) return

    if (this.inFlight.has(noteId)) {
      // A snapshot for this note is still uploading — re-arm rather than pay
      // for a second concurrent full-document encode.
      this.request(noteId)
      return
    }

    this.due.add(noteId)
    this.batchTimer ??= unrefTimer(setTimeout(() => this.flush(), this.batchWindowMs))
  }

  private flush(): void {
    this.batchTimer = null
    if (this.stopped || this.due.size === 0) return

    const noteIds = [...this.due]
    this.due.clear()
    for (const noteId of noteIds) this.inFlight.add(noteId)
    void this.pushFn(noteIds)
      .catch((err) => {
        log.warn('Deferred CRDT snapshot push failed', { noteIds, error: err })
      })
      .finally(() => {
        for (const noteId of noteIds) this.inFlight.delete(noteId)
      })
  }
}

/**
 * Never hold the process open for a deferred snapshot: shutdown flushes
 * outstanding snapshots through pushAllSnapshots(). unref exists only on
 * node's Timeout — platform-free code probes for it structurally.
 */
function unrefTimer(timer: ReturnType<typeof setTimeout>): ReturnType<typeof setTimeout> {
  const maybeUnref = timer as unknown as { unref?: () => void }
  if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
  return timer
}
