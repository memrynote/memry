/**
 * Jobs the large-file worker takes, and the messages it sends back.
 *
 * Its own module so the bridges can type the wire without importing the worker
 * entry, which would pull `worker_threads` bootstrap code into the main bundle.
 *
 * One entry carries both whole-file passes — the line-offset scan and an
 * in-file search — because they are the same shape of job: open one path, cross
 * every byte once, post progress, post a result. A second entry would be a
 * second rollup input and a second copy of the same bootstrap.
 */

import type { LargeFileHit } from './large-file-search'

/**
 * Built filename both bridges load. Registered as a rollup input in
 * `electron.vite.config.ts`; without that entry the file is never emitted and
 * every job silently falls back to running in-process.
 */
export const LARGE_FILE_WORKER_FILE = 'large-file-index-worker.js'

export interface IndexWorkerInput {
  kind: 'index'
  absolutePath: string
  fileBytes: number
}

export interface SearchWorkerInput {
  kind: 'search'
  absolutePath: string
  query: string
  maxHits: number
}

export type LargeFileWorkerInput = IndexWorkerInput | SearchWorkerInput

export type LargeFileWorkerMessage =
  | { type: 'progress'; bytesScanned: number }
  | {
      type: 'done'
      checkpoints: Float64Array
      stride: number
      lineCount: number
      fileBytes: number
    }
  /** `total` is the count so far, not the final one. */
  | { type: 'search-progress'; bytesSearched: number; total: number }
  | {
      type: 'search-done'
      hits: LargeFileHit[]
      total: number
      limited: boolean
      bytesSearched: number
    }
  | { type: 'error'; message: string }
