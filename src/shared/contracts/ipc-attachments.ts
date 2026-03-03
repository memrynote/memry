import { z } from 'zod'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const ATTACHMENT_CHANNELS = {
  UPLOAD_ATTACHMENT: 'sync:upload-attachment',
  GET_UPLOAD_PROGRESS: 'sync:get-upload-progress',
  DOWNLOAD_ATTACHMENT: 'sync:download-attachment',
  GET_DOWNLOAD_PROGRESS: 'sync:get-download-progress'
} as const

// ============================================================================
// Types
// ============================================================================

export interface UploadAttachmentInput {
  noteId: string
  filePath: string
}

export interface UploadAttachmentResult {
  success: boolean
  attachmentId?: string
  sessionId?: string
  error?: string
}

export interface GetUploadProgressInput {
  sessionId: string
}

export interface GetUploadProgressResult {
  progress: number
  uploadedChunks: number
  totalChunks: number
  status: 'uploading' | 'paused' | 'completed' | 'failed'
}

export interface DownloadAttachmentInput {
  attachmentId: string
  targetPath?: string
}

export interface DownloadAttachmentResult {
  success: boolean
  filePath?: string
  error?: string
}

export interface GetDownloadProgressInput {
  attachmentId: string
}

export type DownloadStatus = 'downloading' | 'paused' | 'completed' | 'failed'

export interface GetDownloadProgressResult {
  progress: number
  downloadedChunks: number
  totalChunks: number
  status: DownloadStatus
}

// ============================================================================
// Zod Schemas
// ============================================================================

export const UploadAttachmentSchema = z.object({
  noteId: z.string().min(1),
  filePath: z.string().min(1)
})

export const GetUploadProgressSchema = z.object({
  sessionId: z.string().min(1)
})

export const DownloadAttachmentSchema = z.object({
  attachmentId: z.string().min(1),
  targetPath: z.string().min(1).optional()
})

export const GetDownloadProgressSchema = z.object({
  attachmentId: z.string().min(1)
})

// ============================================================================
// Type Inference
// ============================================================================

export type UploadAttachmentSchemaInput = z.infer<typeof UploadAttachmentSchema>
export type GetUploadProgressSchemaInput = z.infer<typeof GetUploadProgressSchema>
export type DownloadAttachmentSchemaInput = z.infer<typeof DownloadAttachmentSchema>
export type GetDownloadProgressSchemaInput = z.infer<typeof GetDownloadProgressSchema>
