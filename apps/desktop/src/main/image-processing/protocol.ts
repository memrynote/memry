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
