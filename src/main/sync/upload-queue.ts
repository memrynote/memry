import { createLogger } from '../lib/logger'
import { RateLimitError } from './http-client'
import type { ProgressCallback, UploadResult } from './attachments'

const log = createLogger('UploadQueue')

const MAX_CONCURRENT_UPLOADS = 3

export type UploadFn = (
  noteId: string,
  filePath: string,
  onProgress?: ProgressCallback
) => Promise<UploadResult>

interface QueueItem {
  noteId: string
  filePath: string
  onProgress?: ProgressCallback
  resolve: (result: UploadResult) => void
  reject: (error: Error) => void
}

export class UploadQueue {
  private queue: QueueItem[] = []
  private running = 0
  private backoffUntil = 0
  private draining = false
  private readonly uploadFn: UploadFn

  constructor(uploadFn: UploadFn) {
    this.uploadFn = uploadFn
  }

  enqueue(noteId: string, filePath: string, onProgress?: ProgressCallback): Promise<UploadResult> {
    return new Promise<UploadResult>((resolve, reject) => {
      this.queue.push({ noteId, filePath, onProgress, resolve, reject })
      log.debug('enqueued upload', { noteId, queueLength: this.queue.length })
      this.drain()
    })
  }

  clear(): void {
    const pending = this.queue.splice(0)
    for (const item of pending) {
      item.reject(new Error('Upload queue cleared'))
    }
    log.info('queue cleared', { rejected: pending.length })
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
        if (this.backoffUntil > now) {
          const waitMs = this.backoffUntil - now
          log.info('global backoff active', { waitMs })
          await delay(waitMs)
          continue
        }

        const item = this.queue.shift()
        if (!item) break

        this.running++
        this.processItem(item).finally(() => {
          this.running--
          this.drain()
        })
      }
    } finally {
      this.draining = false
    }
  }

  private async processItem(item: QueueItem): Promise<void> {
    try {
      const result = await this.uploadFn(item.noteId, item.filePath, item.onProgress)
      item.resolve(result)
    } catch (err) {
      if (err instanceof RateLimitError) {
        const backoffMs = (err.retryAfter ?? 60) * 1000
        this.backoffUntil = Math.max(this.backoffUntil, Date.now() + backoffMs)
        log.warn('429 received, applying global backoff', { backoffMs })

        this.queue.unshift(item)
        return
      }
      item.reject(err instanceof Error ? err : new Error(String(err)))
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
