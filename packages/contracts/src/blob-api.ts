import { z } from 'zod'

/**
 * SHA-256 hex digest of a chunk's ciphertext (nonce || ciphertext), lowercase.
 * Presigned routes accept hashes only — the R2 object key is derived
 * server-side from the caller's user/vault scope, so clients never submit key
 * material. The strict charset also keeps hashes from ever becoming path
 * fragments in a signed URL.
 */
export const ChunkHashSchema = z.string().regex(/^[a-f0-9]{64}$/, 'must be 64 lowercase hex chars')

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
  encryptedSize: z.number().int().positive().optional(),
  /**
   * Ciphertext hashes of every chunk, in index order — the client finishes
   * encrypting BEFORE initiating, so it knows them at initiate time. When
   * present (and the deployment has R2 presign credentials), the response
   * carries one presigned PUT URL per chunk and the chunks go direct to R2.
   * Length must equal chunkCount; omitted by clients using the proxied path.
   */
  chunkHashes: z.array(ChunkHashSchema).max(128).optional()
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

// ---------------------------------------------------------------------------
// Direct-to-R2 transfers (presigned URLs)
//
// All fields below are OPTIONAL on their request/response schemas: an old
// client never sends them and a server without the R2 presign secrets never
// returns them, so every shape stays wire-compatible in both directions.
// ---------------------------------------------------------------------------

/** POST /sync/attachments/presign-batch — download-side URL issuance. */
export const PresignBatchRequestSchema = z.object({
  chunkHashes: z.array(ChunkHashSchema).min(1).max(1024)
})

export const PresignBatchResponseSchema = z.object({
  /** chunk hash → presigned GET URL. */
  urls: z.record(z.string(), z.string()),
  /** Epoch seconds after which every URL in `urls` stops working. */
  expiresAt: z.number()
})

/**
 * One direct-to-R2 uploaded chunk as reported at complete time. `b` is the
 * ciphertext size actually PUT; the server head-verifies it against R2 before
 * crediting quota.
 */
export const DirectChunkEntrySchema = z.object({
  i: z.number().int().min(0),
  h: ChunkHashSchema,
  b: z.number().int().positive()
})

export type DirectChunkEntry = z.infer<typeof DirectChunkEntrySchema>

export const UploadInitResponseSchema = z.object({
  sessionId: z.string(),
  expiresAt: z.number(),
  /** chunk hash → presigned PUT URL. Absent when the server cannot presign. */
  chunkUrls: z.record(z.string(), z.string()).optional(),
  /** Epoch seconds after which `chunkUrls` stop working. */
  urlExpiresAt: z.number().optional()
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
export type PresignBatchRequest = z.infer<typeof PresignBatchRequestSchema>
export type PresignBatchResponse = z.infer<typeof PresignBatchResponseSchema>
export type ChunkUploadParams = z.infer<typeof ChunkUploadParamsSchema>
export type UploadCompleteRequest = z.infer<typeof UploadCompleteRequestSchema>
export type ChunkExistenceCheck = z.infer<typeof ChunkExistenceCheckSchema>
export type DereferenceRequest = z.infer<typeof DereferenceRequestSchema>
export type UploadInitResponse = z.infer<typeof UploadInitResponseSchema>
export type ChunkUploadResponse = z.infer<typeof ChunkUploadResponseSchema>
export type UploadCompleteResponse = z.infer<typeof UploadCompleteResponseSchema>
export type UploadStatusResponse = z.infer<typeof UploadStatusResponseSchema>
