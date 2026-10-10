/**
 * The languages OCR reads with, by Tesseract code (`eng`, `deu`). English is
 * `bundledDir/eng.traineddata.gz`; every other language is
 * `downloadDir/<code>.traineddata`, gzipped.
 */
export interface OcrLanguageSet {
  codes: string[]
  bundledDir: string
  downloadDir: string
}

/**
 * Image bytes: a vault image read in the main process through the file it
 * checked, or a PNG rendered from a PDF page. Never a path, which the worker
 * would open by name after the check.
 */
export interface OcrImageSource {
  data: Uint8Array
}

export type OcrMainToWorkerMessage =
  { type: 'recognize'; requestId: number; source: OcrImageSource } | { type: 'shutdown' }

// Kept inline rather than imported from telemetry/log-ship.ts so this
// electron-free file (reachable from ocr-worker.ts) never pulls electron into
// the worker bundle. Same shape as lib/log-forward.ts posts.
interface WorkerLogForwardMessage {
  type: 'log'
  record: { level: string; scope?: string; data: unknown[]; date?: string }
}

export type OcrWorkerToMainMessage =
  | { type: 'ready' }
  | { type: 'recognized'; requestId: number; text: string }
  | { type: 'failed'; requestId: number; error: string }
  | WorkerLogForwardMessage
