import { z } from 'zod'

// ============================================================================
// Channel Name Constants
// ============================================================================

export const ATTACHMENT_CHANNELS = {
  UPLOAD_ATTACHMENT: 'sync:upload-attachment',
  GET_UPLOAD_PROGRESS: 'sync:get-upload-progress',
  DOWNLOAD_ATTACHMENT: 'sync:download-attachment',
  GET_DOWNLOAD_PROGRESS: 'sync:get-download-progress',
  DOWNLOAD_NOTE_FILES: 'sync:download-note-files'
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

/**
 * Download the files an opened note is missing on this device: its embedded
 * attachments and, for a binary note, the note's own file. Only does work while
 * attachment auto-download is off; resolves once every file landed or failed.
 */
export interface DownloadNoteFilesInput {
  noteId: string
}

/**
 * What can still bring a file that did not arrive: asking again `now` (Try
 * again), the sync runtime starting (`whenSyncRuns`: sync has not started yet,
 * the vault is held, or the plan has no sync), or `none`: the server no longer
 * has the file, or answered 404 inside its retry window.
 */
export type NoteFilesRetry = 'now' | 'whenSyncRuns' | 'none'

export interface DownloadNoteFilesResult {
  success: boolean
  error?: string
  /** Set on a failure. */
  retry?: NoteFilesRetry
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

export const DownloadNoteFilesSchema = z.object({
  noteId: z.string().min(1)
})

// ============================================================================
// Type Inference
// ============================================================================

export type UploadAttachmentSchemaInput = z.infer<typeof UploadAttachmentSchema>
export type GetUploadProgressSchemaInput = z.infer<typeof GetUploadProgressSchema>
export type DownloadAttachmentSchemaInput = z.infer<typeof DownloadAttachmentSchema>
export type GetDownloadProgressSchemaInput = z.infer<typeof GetDownloadProgressSchema>
