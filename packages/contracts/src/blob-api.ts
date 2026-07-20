import { z } from 'zod'

export const UploadInitRequestSchema = z.object({
  attachmentId: z.string().min(1),
  filename: z.string().min(1),
  /** Plaintext byte size of the file. Plan file-size limits apply to this. */
  totalSize: z.number().int().positive(),
  chunkCount: z.number().int().positive().max(128),
  /**
   * Total byte size actually put on the wire (and stored): every chunk is
   * nonce || ciphertext, so this is larger than `totalSize`. Optional — the
   * server derives it from `totalSize` + `chunkCount` when a client omits it.
   * Storage quota is reserved against this, not `totalSize`.
   */
  encryptedSize: z.number().int().positive().optional()
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

export const DereferenceRequestSchema = z.object({
  chunkHashes: z.array(z.string().min(1)).min(1).max(4096)
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
export type DereferenceRequest = z.infer<typeof DereferenceRequestSchema>
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>
export type ChunkUploadResponse = z.infer<typeof ChunkUploadResponseSchema>
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponseSchema>
export type UploadStatusResponse = z.infer<typeof UploadStatusResponseSchema>
