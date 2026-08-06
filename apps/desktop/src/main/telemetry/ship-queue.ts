import { createLogger } from '../lib/logger'
import type { TelemetryFetch } from './client'
import { createQueueStore } from './queue-store'

const logger = createLogger('LogShip')

export const SHIP_QUEUE_LIMIT = 500
export const SHIP_BATCH_LIMIT = 50

export interface ShipQueueDeps<T> {
  fetch: TelemetryFetch
  endpoint: string
  buildBody: (items: T[]) => unknown
  queueLimit?: number
  batchLimit?: number
  /**
   * Absolute path of the crash-durable mirror. Set → the queue restores whatever
   * the previous process left behind and rewrites the file on every enqueue and
   * flush, so a hard crash no longer discards the last 30s of evidence. Omitted
   * (tests, callers that do not want on-disk state) → memory only, as before.
   */
  persistPath?: string
}

export interface ShipQueueFlushResult {
  success: boolean
  attempted: number
  accepted: number
}

export interface ShipQueue<T> {
  enqueue(item: T): void
  flush(): Promise<ShipQueueFlushResult>
  depth(): number
  setEnabled(enabled: boolean): void
}

export const createShipQueue = <T>(deps: ShipQueueDeps<T>): ShipQueue<T> => {
  const queueLimit = deps.queueLimit ?? SHIP_QUEUE_LIMIT
  const batchLimit = deps.batchLimit ?? SHIP_BATCH_LIMIT
  const store = deps.persistPath ? createQueueStore<T>(deps.persistPath) : null
  const queue: T[] = store ? store.load() : []
  let enabled = false

  const trimQueue = (): void => {
    if (queue.length > queueLimit) {
      queue.splice(0, queue.length - queueLimit)
    }
  }

  const persist = (): void => {
    store?.save(queue)
  }

  // The restored set is bounded by the SAME limit as a live one, so a mirror
  // written by a build with a larger queueLimit cannot resurrect an unbounded
  // queue. Rewrite immediately, otherwise the dropped head returns next launch.
  if (queue.length > queueLimit) {
    trimQueue()
    persist()
  }

  const enqueue = (item: T): void => {
    if (!enabled) return
    queue.push(item)
    trimQueue()
    persist()
  }

  const flush = async (): Promise<ShipQueueFlushResult> => {
    if (!enabled || queue.length === 0) {
      return { success: true, attempted: 0, accepted: 0 }
    }

    const batchSize = Math.min(queue.length, batchLimit)
    const items = queue.slice(0, batchSize)

    try {
      const response = await deps.fetch(deps.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(deps.buildBody(items))
      })

      if (!response.ok) {
        // A 4xx (except 429 rate limit) means the server permanently rejects this
        // payload — e.g. a validation failure. Keeping it re-sends the same head-of-
        // queue batch every flush, wedging the pipeline behind one bad item. Drop it.
        // 5xx and 429 are transient, so leave those queued for a later retry.
        const permanentlyRejected =
          response.status >= 400 && response.status < 500 && response.status !== 429
        if (permanentlyRejected) {
          queue.splice(0, batchSize)
          persist()
        }
        logger.warn('Ship batch rejected', {
          status: response.status,
          dropped: permanentlyRejected
        })
        return { success: false, attempted: batchSize, accepted: 0 }
      }

      queue.splice(0, batchSize)
      persist()
      return { success: true, attempted: batchSize, accepted: batchSize }
    } catch (error) {
      logger.warn('Ship flush failed', {
        error: error instanceof Error ? error.message : String(error)
      })
      return { success: false, attempted: batchSize, accepted: 0 }
    }
  }

  const setEnabled = (next: boolean): void => {
    enabled = next
    if (!next) {
      queue.length = 0
      // Turning telemetry off must leave nothing behind on disk either — a
      // restored mirror would otherwise outlive the opt-out.
      store?.clear()
    }
  }

  return {
    enqueue,
    flush,
    depth: () => queue.length,
    setEnabled
  }
}
