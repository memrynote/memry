/**
 * Messages the line-index worker sends back.
 *
 * Its own module so the bridge can type the wire without importing the worker
 * entry, which would pull `worker_threads` bootstrap code into the main bundle.
 */

export interface IndexWorkerInput {
  absolutePath: string
  fileBytes: number
}

export type IndexWorkerMessage =
  | { type: 'progress'; bytesScanned: number }
  | {
      type: 'done'
      checkpoints: Float64Array
      stride: number
      lineCount: number
      fileBytes: number
    }
  | { type: 'error'; message: string }
