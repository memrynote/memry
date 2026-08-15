/**
 * Worker entry for the large-file line-offset scan.
 *
 * Registered as a rollup input in `electron.vite.config.ts`; the bridge loads
 * the built `large-file-index-worker.js` next to the main bundle. Nothing here
 * touches Electron or the databases — it opens one file, counts newlines
 * through fixed windows, and posts the sparse offset table back.
 *
 * Progress is throttled: a 2 GB scan is ~500 windows, and a message per window
 * would cost more in structured clones than the scan does in reads.
 */

import fs from 'fs/promises'
import { parentPort, workerData } from 'worker_threads'
import { fileHandleReader, scanLineIndex } from './large-file-index'
import type { IndexWorkerInput, IndexWorkerMessage } from './large-file-index-worker-protocol'

const PROGRESS_INTERVAL_MS = 120

function post(message: IndexWorkerMessage): void {
  parentPort?.postMessage(message)
}

async function run(): Promise<void> {
  const { absolutePath, fileBytes } = workerData as IndexWorkerInput
  const handle = await fs.open(absolutePath, 'r')
  try {
    let lastPost = 0
    const index = await scanLineIndex(fileHandleReader(handle), {
      fileBytes,
      onProgress: (bytesScanned) => {
        const now = Date.now()
        if (now - lastPost < PROGRESS_INTERVAL_MS) return
        lastPost = now
        post({ type: 'progress', bytesScanned })
      }
    })
    post({
      type: 'done',
      checkpoints: index.checkpoints,
      stride: index.stride,
      lineCount: index.lineCount,
      fileBytes: index.fileBytes
    })
  } finally {
    await handle.close()
  }
}

run().catch((err: unknown) => {
  post({ type: 'error', message: err instanceof Error ? err.message : String(err) })
})
