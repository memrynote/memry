import { createLogger } from '../lib/logger'
import { NetworkError, RateLimitError } from './http-client'
import { DeadLetterError } from '@memry/sync-client/retry'
import type { NetworkMonitor } from './network'
import type { DownloadResult, ProgressCallback } from './attachments'

const log = createLogger('DownloadQueue')

const MAX_CONCURRENT_DOWNLOADS = 3
// Mirrors UploadQueue: a NetworkError is transient by definition, so the item
// is never dropped, only slowed down. 1s, 2s, ... capped at 60s.
//
// This backoff is GLOBAL across the whole queue, not per item: every network
// error pushes `networkBackoffUntil` forward for ALL items, exactly like
// UploadQueue's shared backoff. A transport blip usually affects every
// transfer equally, so letting the other items keep firing during an outage
// only burns the shared blob_download budget for guaranteed failures.
const NETWORK_BASE_BACKOFF_MS = 1000
const NETWORK_MAX_BACKOFF_MS = 60_000

/**
 * The server's `blob_download` bucket allows 200 requests/min. Every manifest
 * and chunk GET spends one, and this client is not the bucket's only consumer
 * (on-demand fetches, canvas assets), so pace comfortably below the ceiling
 * instead of racing it and eating 429s.
 */
const PACER_MAX_REQUESTS = 150
const PACER_WINDOW_MS = 60_000

/** Files at or under this count as "small" for the small-first ordering. */
const SMALL_FILE_BYTES = 5 * 1024 * 1024

/**
 * Client-side pacing against a fixed-window rate bucket: `acquire()` resolves
 * once issuing one more request keeps the trailing window under `maxRequests`.
 *
 * The limit is READ per iteration, not captured: a bootstrap session (#1837)
 * raises it mid-flight via `setMultiplier` (parked callers speed up as soon as
 * the window slides) and closing the session lowers it again with no parked
 * caller ever exceeding the reverted ceiling.
 */
export class DownloadPacer {
  private stamps: number[] = []
  private multiplier = 1

  constructor(
    private readonly maxRequests: number = PACER_MAX_REQUESTS,
    private readonly windowMs: number = PACER_WINDOW_MS
  ) {}

  /**
   * Multiply the effective ceiling (bootstrap elevation). Values are clamped
   * so a broken factor can never SHRINK pacing below the conservative base —
   * the same direction the server-side seam clamps in.
   */
  setMultiplier(multiplier: number): void {
    this.multiplier = Number.isFinite(multiplier) && multiplier >= 1 ? Math.floor(multiplier) : 1
  }

  get effectiveMaxRequests(): number {
    return Math.max(1, Math.floor(this.maxRequests * this.multiplier))
  }

  async acquire(): Promise<void> {
    // Loop instead of a single wait: several callers can be parked on the same
    // window, and only as many as fit may proceed when it slides.
    for (;;) {
      const now = Date.now()
      while (this.stamps.length > 0 && this.stamps[0] <= now - this.windowMs) {
        this.stamps.shift()
      }
      if (this.stamps.length < this.effectiveMaxRequests) {
        this.stamps.push(now)
        return
      }
      const waitMs = Math.max(1, this.stamps[0] + this.windowMs - now)
      await new Promise<void>((resolve) => setTimeout(resolve, waitMs))
    }
  }
}

/**
 * Rejection used when the queue is torn down (vault switch, runtime restart).
 * Not an outcome: callers must release their download claim instead of
 * recording a failure, so the next pull or re-drive is free to ask again.
 */
export class DownloadQueueClearedError extends Error {
  constructor() {
    super('Download queue cleared')
    this.name = 'DownloadQueueClearedError'
  }
}

export interface DownloadRequest {
  /** Note id (or canvas id) the attachment belongs to. */
  ownerId: string
  attachmentId: string
  targetPath: string
  targetIsDir?: boolean
  onProgress?: ProgressCallback
  /**
   * 'interactive' (a user or renderer is waiting) jumps the queue; 'eager'
   * (pull-apply fan-out) and 'redrive' (failure re-driver) order by the hybrid
   * strategy: small files and recently-used notes first.
   */
  source?: 'interactive' | 'eager' | 'redrive'
  /** Plaintext size in bytes when cheaply known; unknown sorts as neutral. */
  sizeHint?: number
  /** Epoch ms of the owning note's modifiedAt; newer downloads first. */
  recencyHint?: number
}

export type DownloadFn = (
  attachmentId: string,
  targetPath: string,
  opts?: {
    targetIsDir?: boolean
    onProgress?: ProgressCallback
    pace?: () => Promise<void>
    isOnline?: () => boolean
  }
) => Promise<DownloadResult>

interface QueueItem {
  request: DownloadRequest
  enqueuedAt: number
  networkAttempts: number
  resolve: (result: DownloadResult) => void
  reject: (error: Error) => void
}

/** 0 = interactive, then small known files, then unknown sizes, then large. */
function sizeClass(request: DownloadRequest): number {
  if (request.sizeHint === undefined) return 1
  return request.sizeHint <= SMALL_FILE_BYTES ? 0 : 2
}

/** Lower is better. */
function compareItems(a: QueueItem, b: QueueItem): number {
  const aInteractive = a.request.source === 'interactive' ? 0 : 1
  const bInteractive = b.request.source === 'interactive' ? 0 : 1
  if (aInteractive !== bInteractive) return aInteractive - bInteractive

  const sizeDiff = sizeClass(a.request) - sizeClass(b.request)
  if (sizeDiff !== 0) return sizeDiff

  const aRecency = a.request.recencyHint ?? 0
  const bRecency = b.request.recencyHint ?? 0
  if (aRecency !== bRecency) return bRecency - aRecency

  return a.enqueuedAt - b.enqueuedAt
}

/**
 * Global attachment download manager (#1829). The download side used to spawn
 * one unbounded transfer per emit; this bounds concurrency, paces requests
 * against the server's blob_download bucket, pauses globally on 429 honouring
 * Retry-After (mirroring UploadQueue), backs the whole queue off globally on
 * network errors (see NETWORK_BASE_BACKOFF_MS), dedupes concurrent requests
 * for the same attachment + destination, and orders background work by the
 * hybrid priority strategy.
 */
export class DownloadQueue {
  private queue: QueueItem[] = []
  /** keyOf(request) -> unsettled item, for dedupe (queued or running). */
  private byKey = new Map<string, QueueItem>()
  private running = 0
  private backoffUntil = 0
  /** Global network-error backoff deadline — one blip pauses ALL items. */
  private networkBackoffUntil = 0
  private wakeBackoff: (() => void) | null = null
  private draining = false
  private disposed = false
  private readonly downloadFn: DownloadFn
  private readonly network?: NetworkMonitor
  private readonly pacer: DownloadPacer
  private readonly boundHandler?: (ev: { online: boolean }) => void

  constructor(downloadFn: DownloadFn, network?: NetworkMonitor, pacer?: DownloadPacer) {
    this.downloadFn = downloadFn
    this.network = network
    this.pacer = pacer ?? new DownloadPacer()

    if (network) {
      this.boundHandler = (ev: { online: boolean }) => {
        if (!ev.online) return
        // A reconnect makes every escalated delay stale (see UploadQueue).
        for (const queued of this.queue) queued.networkAttempts = 0
        this.resetNetworkBackoff()
        if (this.queue.length > 0) {
          log.info('network restored, draining download queue', { pending: this.queue.length })
          void this.drain()
        }
      }
      network.on('status-changed', this.boundHandler)
    }
  }

  private keyOf(request: DownloadRequest): string {
    // The destination is part of a transfer's identity. The same attachment can
    // legitimately be materialized at two paths concurrently (a canvas asset
    // and an on-demand open both key as ownerId === attachmentId), and the
    // per-destination partial files in AttachmentSyncService exist precisely so
    // those two transfers never share bytes. Deduping them into one transfer
    // would resolve BOTH callers with the winner's filePath while the loser's
    // destination was never written — so fold targetPath (and whether it is a
    // directory, which changes the final file name) into the key.
    return `${request.ownerId}::${request.attachmentId}::${request.targetIsDir ? 'dir' : 'file'}::${request.targetPath}`
  }

  enqueue(request: DownloadRequest): Promise<DownloadResult> {
    const key = this.keyOf(request)
    const existing = this.byKey.get(key)
    if (existing) {
      // Same attachment already queued or in flight — piggyback on it instead
      // of downloading twice. An interactive re-request upgrades the queued
      // item's priority so the waiting caller is not stuck behind bulk work.
      if (request.source === 'interactive' && existing.request.source !== 'interactive') {
        existing.request.source = 'interactive'
      }
      return new Promise<DownloadResult>((resolve, reject) => {
        const originalResolve = existing.resolve
        const originalReject = existing.reject
        existing.resolve = (result) => {
          originalResolve(result)
          resolve(result)
        }
        existing.reject = (error) => {
          originalReject(error)
          reject(error)
        }
      })
    }

    return new Promise<DownloadResult>((resolve, reject) => {
      const item: QueueItem = {
        request,
        enqueuedAt: Date.now(),
        networkAttempts: 0,
        resolve,
        reject
      }
      this.queue.push(item)
      this.byKey.set(key, item)
      log.debug('enqueued download', {
        attachmentId: request.attachmentId,
        source: request.source ?? 'eager',
        queueLength: this.queue.length
      })
      void this.drain()
    })
  }

  clear(): void {
    const pending = this.queue.splice(0)
    for (const item of pending) {
      this.byKey.delete(this.keyOf(item.request))
      item.reject(new DownloadQueueClearedError())
    }
    log.info('queue cleared', { rejected: pending.length })
  }

  /**
   * Bootstrap elevation (#1837): raise (and later revert) the pacer ceiling.
   * Delegated to the pacer so both queued and in-flight transfers pick it up
   * on their next acquire.
   */
  setPaceMultiplier(multiplier: number): void {
    this.pacer.setMultiplier(multiplier)
  }

  dispose(): void {
    this.disposed = true
    if (this.network && this.boundHandler) {
      this.network.removeListener('status-changed', this.boundHandler)
    }
    this.clear()
  }

  get pending(): number {
    return this.queue.length
  }

  get active(): number {
    return this.running
  }

  private takeNext(): QueueItem | undefined {
    if (this.queue.length === 0) return undefined
    let bestIdx = 0
    for (let i = 1; i < this.queue.length; i++) {
      if (compareItems(this.queue[i], this.queue[bestIdx]) < 0) bestIdx = i
    }
    return this.queue.splice(bestIdx, 1)[0]
  }

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.queue.length > 0 && this.running < MAX_CONCURRENT_DOWNLOADS) {
        const now = Date.now()
        const resumeAt = Math.max(this.backoffUntil, this.networkBackoffUntil)
        if (resumeAt > now) {
          const waitMs = resumeAt - now
          log.info('global backoff active', { waitMs })
          await this.waitForBackoff(waitMs)
          continue
        }

        const item = this.takeNext()
        if (!item) break

        this.running++
        void this.processItem(item).finally(() => {
          this.running--
          void this.drain()
        })
      }
    } finally {
      this.draining = false
    }
  }

  /** Interruptible backoff wait — resolves early when the network comes back. */
  private waitForBackoff(ms: number): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        this.wakeBackoff = null
        resolve()
      }, ms)
      this.wakeBackoff = () => {
        clearTimeout(timer)
        this.wakeBackoff = null
        resolve()
      }
    })
  }

  private resetNetworkBackoff(): void {
    this.networkBackoffUntil = 0
    this.wakeBackoff?.()
  }

  private async processItem(item: QueueItem): Promise<void> {
    const { request } = item
    try {
      const result = await this.downloadFn(request.attachmentId, request.targetPath, {
        ...(request.targetIsDir ? { targetIsDir: true } : {}),
        ...(request.onProgress ? { onProgress: request.onProgress } : {}),
        pace: () => this.pacer.acquire(),
        ...(this.network ? { isOnline: () => this.network!.online } : {})
      })
      // A completed transfer proves the network works (see UploadQueue).
      this.resetNetworkBackoff()
      this.byKey.delete(this.keyOf(request))
      item.resolve(result)
    } catch (err) {
      // withRetry inside the download wraps an exhausted budget in
      // DeadLetterError; the queue classifies by the underlying cause.
      const cause = err instanceof DeadLetterError ? err.lastError : err
      if (this.disposed) {
        // The queue died mid-flight (vault switch / runtime restart). Never
        // re-queue into a disposed queue — settle so the caller releases its
        // download claim and the next runtime is free to ask again.
        this.byKey.delete(this.keyOf(request))
        item.reject(new DownloadQueueClearedError())
        return
      }
      if (cause instanceof RateLimitError) {
        const backoffMs = (cause.retryAfter ?? 60) * 1000
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + backoffMs)
        log.warn('429 received, applying global download backoff', { backoffMs })
        this.queue.unshift(item)
        return
      }
      if (cause instanceof NetworkError) {
        item.networkAttempts++
        const backoffMs = Math.min(
          NETWORK_BASE_BACKOFF_MS * 2 ** (item.networkAttempts - 1),
          NETWORK_MAX_BACKOFF_MS
        )
        this.networkBackoffUntil = Math.max(this.networkBackoffUntil, Date.now() + backoffMs)
        log.warn('network error, re-queuing download with backoff', {
          attachmentId: request.attachmentId,
          attempt: item.networkAttempts,
          backoffMs
        })
        this.queue.unshift(item)
        return
      }
      this.byKey.delete(this.keyOf(request))
      item.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
