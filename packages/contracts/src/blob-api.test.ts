/**
 * Blob API Contract Tests
 *
 * Zod schema validation tests for the R2 blob upload protocol:
 * upload-init, chunk upload params, upload-complete, and the
 * matching response envelopes. Covers size / count bounds and
 * the content-hash / blob-key surface exposed to the sync-server.
 */

import { describe, expect, it } from 'vitest'
import {
  ChunkExistenceCheckSchema,
  ChunkUploadParamsSchema,
  ChunkUploadResponseSchema,
  UploadCompleteRequestSchema,
  UploadCompleteResponseSchema,
  UploadInitRequestSchema,
  UploadInitResponseSchema,
  UploadStatusResponseSchema
} from './blob-api'

describe('UploadInitRequestSchema', () => {
  it('accepts a valid init payload', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 1024,
      chunkCount: 4
    })
    expect(result.success).toBe(true)
  })

  it('rejects totalSize of 0 (must be positive)', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 0,
      chunkCount: 1
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('totalSize')
    }
  })

  it('rejects negative totalSize', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: -1,
      chunkCount: 1
    })
    expect(result.success).toBe(false)
  })

  it('rejects non-integer totalSize', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 10.5,
      chunkCount: 1
    })
    expect(result.success).toBe(false)
  })

  it('rejects chunkCount of 0', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 1024,
      chunkCount: 0
    })
    expect(result.success).toBe(false)
  })

  it('rejects chunkCount above the 128-chunk cap', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 1024,
      chunkCount: 129
    })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('chunkCount')
    }
  })

  it('accepts chunkCount at the 128-chunk boundary', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: 'file.pdf',
      totalSize: 10_000_000,
      chunkCount: 128
    })
    expect(result.success).toBe(true)
  })

  it('rejects empty attachmentId', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: '',
      filename: 'file.pdf',
      totalSize: 1024,
      chunkCount: 1
    })
    expect(result.success).toBe(false)
  })

  it('rejects empty filename', () => {
    const result = UploadInitRequestSchema.safeParse({
      attachmentId: 'att-1',
      filename: '',
      totalSize: 1024,
      chunkCount: 1
    })
    expect(result.success).toBe(false)
  })
})

describe('ChunkUploadParamsSchema', () => {
  it('accepts valid sessionId + chunkIndex', () => {
    const result = ChunkUploadParamsSchema.safeParse({ sessionId: 'sess-1', chunkIndex: 0 })
    expect(result.success).toBe(true)
  })

  it('accepts chunkIndex at 0 (first chunk)', () => {
    const result = ChunkUploadParamsSchema.safeParse({ sessionId: 'sess-1', chunkIndex: 0 })
    expect(result.success).toBe(true)
  })

  it('rejects negative chunkIndex', () => {
    const result = ChunkUploadParamsSchema.safeParse({ sessionId: 'sess-1', chunkIndex: -1 })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('chunkIndex')
    }
  })

  it('rejects non-integer chunkIndex', () => {
    const result = ChunkUploadParamsSchema.safeParse({ sessionId: 'sess-1', chunkIndex: 1.5 })
    expect(result.success).toBe(false)
  })

  it('rejects empty sessionId', () => {
    const result = ChunkUploadParamsSchema.safeParse({ sessionId: '', chunkIndex: 0 })
    expect(result.success).toBe(false)
  })
})

describe('UploadCompleteRequestSchema', () => {
  it('accepts a valid sessionId', () => {
    const result = UploadCompleteRequestSchema.safeParse({ sessionId: 'sess-1' })
    expect(result.success).toBe(true)
  })

  it('rejects empty sessionId', () => {
    const result = UploadCompleteRequestSchema.safeParse({ sessionId: '' })
    expect(result.success).toBe(false)
  })
})

describe('ChunkExistenceCheckSchema', () => {
  it('accepts a non-empty hash', () => {
    const result = ChunkExistenceCheckSchema.safeParse({ hash: 'deadbeef' })
    expect(result.success).toBe(true)
  })

  it('rejects an empty hash', () => {
    const result = ChunkExistenceCheckSchema.safeParse({ hash: '' })
    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.issues[0].path).toContain('hash')
    }
  })
})

describe('UploadInitResponseSchema', () => {
  it('accepts a valid init response', () => {
    const result = UploadInitResponseSchema.safeParse({
      sessionId: 'sess-1',
      expiresAt: 1700000000
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing sessionId', () => {
    const result = UploadInitResponseSchema.safeParse({ expiresAt: 1700000000 })
    expect(result.success).toBe(false)
  })

  it('rejects missing expiresAt', () => {
    const result = UploadInitResponseSchema.safeParse({ sessionId: 'sess-1' })
    expect(result.success).toBe(false)
  })

  it('rejects non-numeric expiresAt', () => {
    const result = UploadInitResponseSchema.safeParse({
      sessionId: 'sess-1',
      expiresAt: 'tomorrow'
    })
    expect(result.success).toBe(false)
  })
})

describe('ChunkUploadResponseSchema', () => {
  it('accepts valid success + uploadedChunks', () => {
    const result = ChunkUploadResponseSchema.safeParse({ success: true, uploadedChunks: 5 })
    expect(result.success).toBe(true)
  })

  it('rejects non-boolean success', () => {
    const result = ChunkUploadResponseSchema.safeParse({ success: 'yes', uploadedChunks: 5 })
    expect(result.success).toBe(false)
  })
})

describe('UploadCompleteResponseSchema', () => {
  it('accepts success only (no blob metadata on failure)', () => {
    const result = UploadCompleteResponseSchema.safeParse({ success: false })
    expect(result.success).toBe(true)
  })

  it('accepts success with R2 blob metadata', () => {
    const result = UploadCompleteResponseSchema.safeParse({
      success: true,
      blobKey: 'users/u1/att-1',
      sizeBytes: 1024,
      contentHash: 'sha256:deadbeef'
    })
    expect(result.success).toBe(true)
  })

  it('rejects missing success flag', () => {
    const result = UploadCompleteResponseSchema.safeParse({
      blobKey: 'users/u1/att-1',
      sizeBytes: 1024,
      contentHash: 'sha256:deadbeef'
    })
    expect(result.success).toBe(false)
  })
})

describe('UploadStatusResponseSchema', () => {
  it('accepts a valid status response', () => {
    const result = UploadStatusResponseSchema.safeParse({
      sessionId: 'sess-1',
      attachmentId: 'att-1',
      totalSize: 1024,
      chunkCount: 4,
      uploadedChunks: [0, 1, 2],
      expiresAt: 1700000000
    })
    expect(result.success).toBe(true)
  })

  it('accepts an empty uploadedChunks array', () => {
    const result = UploadStatusResponseSchema.safeParse({
      sessionId: 'sess-1',
      attachmentId: 'att-1',
      totalSize: 1024,
      chunkCount: 4,
      uploadedChunks: [],
      expiresAt: 1700000000
    })
    expect(result.success).toBe(true)
  })

  it('rejects a non-array uploadedChunks', () => {
    const result = UploadStatusResponseSchema.safeParse({
      sessionId: 'sess-1',
      attachmentId: 'att-1',
      totalSize: 1024,
      chunkCount: 4,
      uploadedChunks: 'all',
      expiresAt: 1700000000
    })
    expect(result.success).toBe(false)
  })

  it('rejects missing required fields', () => {
    const result = UploadStatusResponseSchema.safeParse({
      sessionId: 'sess-1',
      attachmentId: 'att-1'
    })
    expect(result.success).toBe(false)
  })
})
