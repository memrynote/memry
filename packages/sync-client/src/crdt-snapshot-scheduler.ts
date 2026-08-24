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

interface PendingSnapshot {
  timer: ReturnType<typeof setTimeout>
  firstRequestedAt: number
}

export interface CrdtSnapshotSchedulerOptions {
  quietMs?: number
  maxWaitMs?: number
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
  private inFlight = new Set<string>()
  private stopped = false
  private readonly quietMs: number
  private readonly maxWaitMs: number
  private readonly now: () => number

  constructor(
    private readonly pushFn: (noteId: string) => Promise<unknown>,
    options: CrdtSnapshotSchedulerOptions = {}
  ) {
    this.quietMs = options.quietMs ?? SNAPSHOT_QUIET_MS
    this.maxWaitMs = options.maxWaitMs ?? SNAPSHOT_MAX_WAIT_MS
    this.now = options.now ?? Date.now
  }

  request(noteId: string): void {
    if (this.stopped) return

    const existing = this.pending.get(noteId)
    const firstRequestedAt = existing?.firstRequestedAt ?? this.now()
    if (existing) clearTimeout(existing.timer)

    const remainingMaxWait = firstRequestedAt + this.maxWaitMs - this.now()
    const delay = Math.max(0, Math.min(this.quietMs, remainingMaxWait))

    const timer = setTimeout(() => this.fire(noteId), delay)
    // Never hold the process open for a deferred snapshot: shutdown flushes
    // outstanding snapshots through pushAllSnapshots(). unref exists only on
    // node's Timeout — platform-free code probes for it structurally.
    const maybeUnref = timer as unknown as { unref?: () => void }
    if (typeof maybeUnref.unref === 'function') maybeUnref.unref()
    this.pending.set(noteId, { timer, firstRequestedAt })
  }

  stop(): void {
    this.stopped = true
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  getPendingNoteIds(): string[] {
    return Array.from(this.pending.keys())
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

    this.inFlight.add(noteId)
    void this.pushFn(noteId)
      .catch((err) => {
        log.warn('Deferred CRDT snapshot push failed', { noteId, error: err })
      })
      .finally(() => {
        this.inFlight.delete(noteId)
      })
  }
}
