import { createLogger } from '../lib/logger'
import { NetworkError, RateLimitError } from './http-client'
import type { NetworkMonitor } from './network'
import type { ProgressCallback, UploadResult } from './attachments'

const log = createLogger('UploadQueue')

const MAX_CONCURRENT_UPLOADS = 3
// A NetworkError is transient by definition — the machine is offline or the
// server is unreachable — so the item is NEVER dropped, only slowed down.
// Delays go 1s, 2s, 4s, 8s, 16s, 32s and then sit on the ceiling forever.
// Without this the re-queue below spun the CPU (and re-encrypted the whole
// attachment) as fast as the transfer could fail.
const NETWORK_BASE_BACKOFF_MS = 1000
const NETWORK_MAX_BACKOFF_MS = 60_000

export type UploadFn = (
  noteId: string,
  filePath: string,
  onProgress?: ProgressCallback,
  options?: { signal?: AbortSignal; isOnline?: () => boolean }
) => Promise<UploadResult>

interface QueueItem {
  noteId: string
  filePath: string
  onProgress?: ProgressCallback
  networkAttempts: number
  resolve: (result: UploadResult) => void
  reject: (error: Error) => void
}

export class UploadQueue {
  private queue: QueueItem[] = []
  private running = 0
  private backoffUntil = 0
  private networkBackoffUntil = 0
  private wakeBackoff: (() => void) | null = null
  private draining = false
  private readonly uploadFn: UploadFn
  private readonly network?: NetworkMonitor
  private readonly boundHandler?: (ev: { online: boolean }) => void

  constructor(uploadFn: UploadFn, network?: NetworkMonitor) {
    this.uploadFn = uploadFn
    this.network = network

    if (network) {
      this.boundHandler = (ev: { online: boolean }) => {
        if (!ev.online) return
        // A reconnect makes every escalated delay stale. Clear the per-item
        // counts too, otherwise someone who was offline overnight comes back
        // and still waits out a ceiling-length backoff before anything moves.
        for (const queued of this.queue) queued.networkAttempts = 0
        this.resetNetworkBackoff()
        if (this.queue.length > 0) {
          log.info('network restored, draining upload queue', { pending: this.queue.length })
          void this.drain()
        }
      }
      network.on('status-changed', this.boundHandler)
    }
  }

  enqueue(noteId: string, filePath: string, onProgress?: ProgressCallback): Promise<UploadResult> {
    return new Promise<UploadResult>((resolve, reject) => {
      this.queue.push({ noteId, filePath, onProgress, networkAttempts: 0, resolve, reject })
      log.debug('enqueued upload', { noteId, queueLength: this.queue.length })
      void this.drain()
    })
  }

  clear(): void {
    const pending = this.queue.splice(0)
    for (const item of pending) {
      item.reject(new Error('Upload queue cleared'))
    }
    log.info('queue cleared', { rejected: pending.length })
  }

  dispose(): void {
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

  private async drain(): Promise<void> {
    if (this.draining) return
    this.draining = true

    try {
      while (this.queue.length > 0 && this.running < MAX_CONCURRENT_UPLOADS) {
        const now = Date.now()
        const resumeAt = Math.max(this.backoffUntil, this.networkBackoffUntil)
        if (resumeAt > now) {
          const waitMs = resumeAt - now
          log.info('global backoff active', { waitMs })
          await this.waitForBackoff(waitMs)
          continue
        }

        const item = this.queue.shift()
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

  /** Drop the shared network wait and let a sleeping drain() proceed at once. */
  private resetNetworkBackoff(): void {
    this.networkBackoffUntil = 0
    this.wakeBackoff?.()
  }

  private async processItem(item: QueueItem): Promise<void> {
    try {
      const result = await this.uploadFn(item.noteId, item.filePath, item.onProgress, {
        isOnline: this.network ? () => this.network!.online : undefined
      })
      // A completed transfer proves the network works, so nothing should still
      // be sitting behind a network backoff another item scheduled.
      this.resetNetworkBackoff()
      item.resolve(result)
    } catch (err) {
      if (err instanceof RateLimitError) {
        const backoffMs = (err.retryAfter ?? 60) * 1000
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + backoffMs)
        log.warn('429 received, applying global backoff', { backoffMs })

        this.queue.unshift(item)
        return
      }
      if (err instanceof NetworkError) {
        item.networkAttempts++
        const backoffMs = Math.min(
          NETWORK_BASE_BACKOFF_MS * 2 ** (item.networkAttempts - 1),
          NETWORK_MAX_BACKOFF_MS
        )
        this.networkBackoffUntil = Math.max(this.networkBackoffUntil, Date.now() + backoffMs)
        log.warn('network error, re-queuing upload with backoff', {
          noteId: item.noteId,
          attempt: item.networkAttempts,
          backoffMs
        })
        this.queue.unshift(item)
        return
      }
      item.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
}
