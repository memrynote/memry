/**
 * Runs an in-file search off the main thread.
 *
 * Same shape, and the same worker entry, as the line-offset scan in
 * `large-file-index-bridge.ts`: one pass over every byte of a file, which is a
 * stall at 2 GB however carefully it is chunked, so it does not belong on the
 * process that draws the window. The worker is spawned per search — a search is
 * a one-shot job, and thread startup is milliseconds against a multi-second
 * pass.
 *
 * Unlike the scan, a search is routinely thrown away: every keystroke supersedes
 * the last query. `cancel` is therefore first-class — it terminates the thread
 * rather than letting an abandoned query finish crossing the file.
 *
 * If the thread cannot start, the same search runs here instead, over the
 * caller's already-open handle. It reads through async windows, so it yields to
 * the event loop between them and stops at the next window when cancelled.
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { createLogger } from '../lib/logger'
import { asError } from './large-file-index-bridge'
import type { ByteReader } from './large-file-index'
import { findMatches, MAX_SEARCH_HITS, type FindMatchesResult } from './large-file-search'
import {
  LARGE_FILE_WORKER_FILE,
  type LargeFileWorkerMessage
} from './large-file-index-worker-protocol'

const logger = createLogger('LargeFileSearchBridge')

export interface FileSearchRun {
  result: Promise<FindMatchesResult>
  /** Stop the pass. `result` still settles, with `cancelled` set. */
  cancel: () => void
}

function cancelledResult(): FindMatchesResult {
  return { hits: [], total: 0, limited: false, cancelled: true, bytesSearched: 0 }
}

export function runFileSearch(
  absolutePath: string,
  query: string,
  read: ByteReader,
  onProgress: (bytesSearched: number, total: number) => void
): FileSearchRun {
  let cancelled = false
  let stopWorker: (() => void) | null = null

  // Started synchronously, so `cancel` below can never arrive before there is
  // anything to cancel.
  const result = (async (): Promise<FindMatchesResult> => {
    try {
      return await searchOnWorker(absolutePath, query, onProgress, (stop) => {
        stopWorker = stop
      })
    } catch (err) {
      if (cancelled) return cancelledResult()
      logger.warn('In-file search could not use a worker; searching in-process', { err })
      return findMatches(read, {
        query,
        maxHits: MAX_SEARCH_HITS,
        onProgress,
        shouldStop: () => cancelled
      })
    }
  })()

  return {
    result,
    cancel: () => {
      cancelled = true
      stopWorker?.()
    }
  }
}

function searchOnWorker(
  absolutePath: string,
  query: string,
  onProgress: (bytesSearched: number, total: number) => void,
  register: (stop: () => void) => void
): Promise<FindMatchesResult> {
  return new Promise<FindMatchesResult>((resolve, reject) => {
    const worker = new Worker(join(__dirname, LARGE_FILE_WORKER_FILE), {
      workerData: { kind: 'search', absolutePath, query, maxHits: MAX_SEARCH_HITS }
    })

    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      worker.removeAllListeners()
      void worker.terminate()
      run()
    }

    register(() => finish(() => resolve(cancelledResult())))

    worker.on('message', (message: LargeFileWorkerMessage) => {
      if (message.type === 'search-progress') {
        onProgress(message.bytesSearched, message.total)
        return
      }
      if (message.type === 'search-done') {
        finish(() =>
          resolve({
            hits: message.hits,
            total: message.total,
            limited: message.limited,
            cancelled: false,
            bytesSearched: message.bytesSearched
          })
        )
        return
      }
      if (message.type === 'error') finish(() => reject(new Error(message.message)))
    })

    // Same wrapping as the line-index bridge, for the same reason: the
    // in-process fallback below keeps the find bar working, so this log line is
    // the only trace that the worker was abandoned at all.
    worker.on('error', (err: unknown) => finish(() => reject(asError(err))))
    worker.on('exit', (code) => {
      finish(() => reject(new Error(`Large-file worker exited with code ${code}`)))
    })
  })
}
