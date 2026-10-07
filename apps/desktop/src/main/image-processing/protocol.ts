export interface ImageProcessingThumbnailPayload {
  data: Uint8Array
  width: number
  height: number
  format: 'webp' | 'png'
}

export interface InboxImageMetadataPayload {
  format: string
  width: number
  height: number
  hasExif: boolean
}

export interface InboxImageProcessingPayload {
  metadata: InboxImageMetadataPayload
  thumbnailData: Uint8Array | null
}

/** A file on disk, or PNG bytes such as a rendered PDF page. */
export type ViewImageSource = { kind: 'file'; path: string } | { kind: 'png'; data: Uint8Array }

/** An image an agent can look at, and the size of the image it came from. */
export interface ViewImagePayload {
  data: Uint8Array
  mimeType: 'image/png' | 'image/jpeg'
  width: number
  height: number
  sourceWidth: number
  sourceHeight: number
}

export type ImageProcessingMainToWorkerMessage =
  | {
      type: 'generate-thumbnail'
      requestId: string
      filePath: string
      mimeType: string
    }
  | {
      type: 'process-inbox-image'
      requestId: string
      filePath: string
    }
  | {
      type: 'prepare-view-image'
      requestId: string
      source: ViewImageSource
      maxEdge: number
    }
  | {
      type: 'shutdown'
    }

// Forwarded worker warn/error log record (see lib/log-forward.ts). Kept
// inline rather than importing from telemetry/log-ship.ts so this
// electron-free protocol file (reachable from image-processing/worker.ts)
// never risks pulling electron into the worker bundle.
export interface WorkerLogForwardMessage {
  type: 'log'
  record: { level: string; scope?: string; data: unknown[]; date?: string }
}

export type ImageProcessingWorkerToMainMessage =
  | {
      type: 'ready'
    }
  | {
      type: 'thumbnail-result'
      requestId: string
      result: ImageProcessingThumbnailPayload | null
    }
  | {
      type: 'inbox-image-result'
      requestId: string
      result: InboxImageProcessingPayload | null
    }
  | {
      type: 'view-image-result'
      requestId: string
      result: ViewImagePayload
    }
  | {
      type: 'error'
      requestId: string
      error: string
    }
  | WorkerLogForwardMessage
