/**
 * Worker entry for the large-file whole-file passes.
 *
 * Registered as a rollup input in `electron.vite.config.ts`; the bridges load
 * the built `large-file-index-worker.js` next to the main bundle. Nothing here
 * touches Electron or the databases — it opens one file, crosses it once
 * through fixed windows, and posts the result back.
 *
 * Two jobs share the entry: the line-offset scan, and an in-file search. Both
 * are one pass over every byte, which is a stall at 2 GB wherever it runs, so
 * both belong off the main thread.
 *
 * Progress is throttled: a 2 GB pass is ~500 windows, and a message per window
 * would cost more in structured clones than the pass does in reads.
 */

import fs from 'fs/promises'
import type { FileHandle } from 'fs/promises'
import { parentPort, workerData } from 'worker_threads'
import { fileHandleReader, scanLineIndex } from './large-file-index'
import { findMatches } from './large-file-search'
import type {
  IndexWorkerInput,
  LargeFileWorkerInput,
  LargeFileWorkerMessage,
  SearchWorkerInput
} from './large-file-index-worker-protocol'

const PROGRESS_INTERVAL_MS = 120

function post(message: LargeFileWorkerMessage): void {
  parentPort?.postMessage(message)
}

/** True at most every `PROGRESS_INTERVAL_MS`, so progress cannot flood the wire. */
function throttle(): () => boolean {
  let lastPost = 0
  return () => {
    const now = Date.now()
    if (now - lastPost < PROGRESS_INTERVAL_MS) return false
    lastPost = now
    return true
  }
}

async function runIndex(input: IndexWorkerInput, handle: FileHandle): Promise<void> {
  const due = throttle()
  const index = await scanLineIndex(fileHandleReader(handle), {
    fileBytes: input.fileBytes,
    onProgress: (bytesScanned) => {
      if (due()) post({ type: 'progress', bytesScanned })
    }
  })
  post({
    type: 'done',
    checkpoints: index.checkpoints,
    stride: index.stride,
    lineCount: index.lineCount,
    fileBytes: index.fileBytes
  })
}

async function runSearch(input: SearchWorkerInput, handle: FileHandle): Promise<void> {
  const due = throttle()
  const found = await findMatches(fileHandleReader(handle), {
    query: input.query,
    maxHits: input.maxHits,
    onProgress: (bytesSearched, total) => {
      if (due()) post({ type: 'search-progress', bytesSearched, total })
    }
  })
  post({
    type: 'search-done',
    hits: found.hits,
    total: found.total,
    limited: found.limited,
    bytesSearched: found.bytesSearched
  })
}

async function run(): Promise<void> {
  const input = workerData as LargeFileWorkerInput
  const handle = await fs.open(input.absolutePath, 'r')
  try {
    if (input.kind === 'search') {
      await runSearch(input, handle)
    } else {
      await runIndex(input, handle)
    }
  } finally {
    await handle.close()
  }
}

run().catch((err: unknown) => {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
})
