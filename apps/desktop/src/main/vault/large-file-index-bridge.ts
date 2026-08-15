/**
 * Runs a file's line-offset scan off the main thread.
 *
 * The scan is one pass over every byte of the file. On the main process that is
 * a stall at 2 GB however carefully it is chunked, so it belongs on a worker.
 * The worker is spawned per scan rather than pooled: a scan is a one-shot job,
 * and thread startup is milliseconds against a multi-second pass.
 *
 * If the thread cannot start — a build that shipped without the rollup entry, a
 * platform that refuses the spawn — the same scan runs here instead, over the
 * caller's already-open handle. It reads through async windows, so it yields to
 * the event loop between chunks and cannot lock the process the way the
 * BlockNote parse did; it is slower company for the UI, but a viewer that opens
 * beats a viewer that does not.
 *
 * The fallback deliberately takes a reader rather than reopening the path. The
 * worker has no choice — a thread cannot inherit a file handle, so it opens the
 * path itself — but resolving the same path twice in-process is a race the
 * caller has already ruled out by holding the file open.
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { createLogger } from '../lib/logger'
import { scanLineIndex, type ByteReader, type LineIndex } from './large-file-index'
import type { IndexWorkerMessage } from './large-file-index-worker-protocol'

const logger = createLogger('LargeFileIndexBridge')

export async function buildLineIndex(
  absolutePath: string,
  fileBytes: number,
  read: ByteReader,
  onProgress: (bytesScanned: number) => void
): Promise<LineIndex> {
  try {
    return await scanOnWorker(absolutePath, fileBytes, onProgress)
  } catch (err) {
    logger.warn('Line-offset scan could not use a worker; scanning in-process', { err })
    return scanLineIndex(read, { fileBytes, onProgress })
  }
}

function scanOnWorker(
  absolutePath: string,
  fileBytes: number,
  onProgress: (bytesScanned: number) => void
): Promise<LineIndex> {
  return new Promise<LineIndex>((resolve, reject) => {
    const worker = new Worker(join(__dirname, 'large-file-index-worker.js'), {
      workerData: { absolutePath, fileBytes }
    })

    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      worker.removeAllListeners()
      void worker.terminate()
      run()
    }

    worker.on('message', (message: IndexWorkerMessage) => {
      if (message.type === 'progress') {
        onProgress(message.bytesScanned)
        return
      }
      if (message.type === 'done') {
        finish(() =>
          resolve({
            checkpoints: message.checkpoints,
            stride: message.stride,
            lineCount: message.lineCount,
            fileBytes: message.fileBytes
          })
        )
        return
      }
      finish(() => reject(new Error(message.message)))
    })

    worker.on('error', (err) => finish(() => reject(err)))
    worker.on('exit', (code) => {
      finish(() => reject(new Error(`Line-index worker exited with code ${code}`)))
    })
  })
}
