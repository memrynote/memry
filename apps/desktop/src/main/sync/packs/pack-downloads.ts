import type { PackSummary } from '@memry/contracts/sync-api'

import { createLogger } from '../../lib/logger'
import { NetworkError, RateLimitError, SyncServerError } from '../http-client'

const log = createLogger('PackDownloads')

/**
 * The pack phase's pauses after a GET the network may cure (protocol 08
 * §8.12, A network drop during the download): the lost packs download again
 * after each one, and a pack still lost after the last is a gap.
 */
export const PACK_RETRY_PAUSES_MS = [30_000, 60_000, 120_000, 240_000] as const

/** How one pack GET ended: held, lost to a curable failure (with the least pause it asks for), or a gap. */
export type PackFetch<T> = { held: T } | { lostMs: number } | 'gap'

const CURABLE_STATUSES: ReadonlySet<number> = new Set([500, 502, 503, 504])

/**
 * The least pause a failed pack GET asks for when the network may cure it,
 * or null when it is final: offline, a failed or interrupted connection, a
 * 5xx, a 429 (at least its `Retry-After`), or a 403 on a URL that expired
 * while the transport retried. A 404, a 403 on a live URL and anything else
 * make the pack a gap.
 */
export const curablePauseMs = (error: unknown, urlExpired: boolean): number | null => {
  if (error instanceof RateLimitError) return error.retryAfterMs
  if (error instanceof NetworkError) return 0
  if (error instanceof SyncServerError) {
    if (CURABLE_STATUSES.has(error.statusCode)) return 0
    if (error.statusCode === 403 && urlExpired) return 0
  }
  return null
}

const abortableSleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve()
    const done = (): void => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', done)
      resolve()
    }
    const timer = setTimeout(done, ms)
    signal?.addEventListener('abort', done, { once: true })
  })

export interface PackDownloadsOptions<T> {
  parallel: number
  fetchOne: (pack: PackSummary) => Promise<PackFetch<T>>
  /** Called after each pause, before the lost packs download again: a new re-list is allowed. */
  onPause: () => void
  signal?: AbortSignal
  /** Injected for tests; production waits on a real timer the signal cuts short. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
}

/**
 * Every pack GET of one phase, in order, at most `parallel` at once. The
 * first curable loss pauses the phase: no new GET starts, the running ones
 * finish, and after the pause every lost or unstarted pack goes again. One
 * phase-wide pause, not one per pack: in an outage every pack fails together,
 * and a ladder per queued pack would spend them all inside the same drop.
 * Returns each pack's held value, or null for a gap.
 */
export const downloadPacks = async <T>(
  packs: readonly PackSummary[],
  options: PackDownloadsOptions<T>
): Promise<Array<T | null>> => {
  const sleep = options.sleep ?? abortableSleep
  const held: Array<T | null> = packs.map(() => null)
  let queue = packs.map((_, index) => index)
  for (let pause = 0; ; pause++) {
    const lost: number[] = []
    let lostMs = -1
    let next = 0
    const worker = async (): Promise<void> => {
      while (lostMs < 0 && !options.signal?.aborted && next < queue.length) {
        const index = queue[next++]
        const result = await options.fetchOne(packs[index])
        if (result === 'gap') continue
        if ('held' in result) held[index] = result.held
        else {
          lost.push(index)
          lostMs = Math.max(lostMs, result.lostMs)
        }
      }
    }
    await Promise.all(
      Array.from({ length: Math.min(Math.max(1, options.parallel), queue.length) }, worker)
    )
    if (lost.length === 0 || options.signal?.aborted) return held
    const again = [...lost, ...queue.slice(next)].toSorted((a, b) => a - b)
    if (pause === PACK_RETRY_PAUSES_MS.length) {
      log.info('Packs still lost after the last pause — their ranges stay item-granular', {
        lost: again.length
      })
      return held
    }
    const waitMs = Math.max(PACK_RETRY_PAUSES_MS[pause], lostMs)
    log.info('Pack phase paused after a network failure', {
      pause: pause + 1,
      waitMs,
      lost: lost.length,
      unstarted: again.length - lost.length
    })
    await sleep(waitMs, options.signal)
    if (options.signal?.aborted) return held
    options.onPause()
    queue = again
  }
}
