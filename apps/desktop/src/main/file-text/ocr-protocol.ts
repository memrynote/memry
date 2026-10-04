/** An image file on disk, or a PNG rendered from a PDF page. */
export type OcrImageSource = { kind: 'file'; path: string } | { kind: 'png'; data: Uint8Array }

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
