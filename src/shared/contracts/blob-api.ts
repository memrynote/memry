import { z } from 'zod'

export const UploadInitRequestSchema = z.object({
  attachmentId: z.string().min(1),
  filename: z.string().min(1),
  totalSize: z.number().int().positive(),
  chunkCount: z.number().int().positive().max(128)
})

export const ChunkUploadParamsSchema = z.object({
  sessionId: z.string().min(1),
  chunkIndex: z.number().int().min(0)
})

export const UploadCompleteRequestSchema = z.object({
  sessionId: z.string().min(1)
})

export const ChunkExistenceCheckSchema = z.object({
  hash: z.string().min(1)
})

export const UploadInitResponseSchema = z.object({
  sessionId: z.string(),
  expiresAt: z.number()
})

export const ChunkUploadResponseSchema = z.object({
  success: z.boolean(),
  uploadedChunks: z.number()
})

export const UploadCompleteResponseSchema = z.object({
  success: z.boolean(),
  blobKey: z.string().optional(),
  sizeBytes: z.number().optional(),
  contentHash: z.string().optional()
})

export const UploadStatusResponseSchema = z.object({
  sessionId: z.string(),
  attachmentId: z.string(),
  totalSize: z.number(),
  chunkCount: z.number(),
  uploadedChunks: z.array(z.number()),
  expiresAt: z.number()
})

export type UploadInitRequest = z.infer<typeof UploadInitRequestSchema>
export type ChunkUploadParams = z.infer<typeof ChunkUploadParamsSchema>
export type UploadCompleteRequest = z.infer<typeof UploadCompleteRequestSchema>
export type ChunkExistenceCheck = z.infer<typeof ChunkExistenceCheckSchema>
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>
export type ChunkUploadResponse = z.infer<typeof ChunkUploadResponseSchema>
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponseSchema>
export type UploadStatusResponse = z.infer<typeof UploadStatusResponseSchema>
