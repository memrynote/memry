/**
 * Hashes a file off the main thread, on the large-file worker entry: a binary
 * note's file can be gigabytes, and a first upload of a vault hashes every one
 * (#5608). The worker is spawned per hash, like the line-offset scan's.
 *
 * If the thread cannot start, the same hash runs here through async 1 MiB
 * reads, which yield to the event loop between windows.
 */

import { Worker } from 'worker_threads'
import { join } from 'path'
import { createLogger } from '../lib/logger'
import { sha256OfFile } from './file-sha256'
import { asError } from './large-file-index-bridge'
import {
  LARGE_FILE_WORKER_FILE,
  type LargeFileWorkerMessage
} from './large-file-index-worker-protocol'

const logger = createLogger('FileHashBridge')

/** The sha256 (hex) of the file at `filePath`, or null when nothing is there. */
export async function hashFileOffThread(filePath: string): Promise<string | null> {
  try {
    return await hashOnWorker(filePath)
  } catch (err) {
    logger.warn('File hash could not use a worker; hashing in-process', { err })
    return sha256OfFile(filePath)
  }
}

function hashOnWorker(absolutePath: string): Promise<string | null> {
  return new Promise<string | null>((resolve, reject) => {
    const worker = new Worker(join(__dirname, LARGE_FILE_WORKER_FILE), {
      workerData: { kind: 'hash', absolutePath }
    })

    let settled = false
    const finish = (run: () => void): void => {
      if (settled) return
      settled = true
      worker.removeAllListeners()
      void worker.terminate()
      run()
    }

    worker.on('message', (message: LargeFileWorkerMessage) => {
      if (message.type === 'hash-done') finish(() => resolve(message.sha256))
      if (message.type === 'error') finish(() => reject(new Error(message.message)))
    })
    worker.on('error', (err: unknown) => finish(() => reject(asError(err))))
    worker.on('exit', (code) => {
      finish(() => reject(new Error(`File hash worker exited with code ${code}`)))
    })
  })
}
