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
      type: 'error'
      requestId: string
      error: string
    }
  | WorkerLogForwardMessage
