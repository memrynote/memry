import { Hono } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { authMiddleware } from '../middleware/auth'
import { paidSyncMiddleware } from '../middleware/paid-sync'
import { createRateLimiter } from '../middleware/rate-limit'
import {
  deleteBlob,
  generateAttachmentChunkKey,
  generateAttachmentManifestKey,
  generateBlobKey,
  getBlob,
  putBlob
} from '../services/blob'
import { assertFileSizeAllowed } from '../services/entitlements'
import { adjustStorageUsed, reserveStorage } from '../services/quota'
import { UploadInitRequestSchema } from '@memry/contracts/blob-api'
import type { AppContext } from '../types'

const logger = createLogger('BlobRoutes')

/**
 * Refunds a storage reservation after a failed write.
 *
 * The refund is itself a D1 write, so during a D1 outage it fails too. It must
 * never replace the error that actually caused the write to fail: that turns a
 * typed, handled error into an unhandled one and hides the real cause. A failed
 * refund leaves the reservation charged to the user until reconciliation.
 */
const refundReservation = async (
  db: D1Database,
  userId: string,
  reservedBytes: number,
  context: Record<string, unknown>
): Promise<void> => {
  if (reservedBytes <= 0) return
  try {
    await adjustStorageUsed(db, userId, -reservedBytes)
  } catch (refundError) {
    logger.error('storage refund failed', {
      ...context,
      reservedBytes,
      error: refundError instanceof Error ? refundError.message : String(refundError)
    })
  }
}

export const blob = new Hono<AppContext>()

blob.use('*', authMiddleware)
blob.use('*', paidSyncMiddleware)

const MAX_FILE_SIZE = 500 * 1024 * 1024
const UPLOAD_SESSION_TTL = 24 * 60 * 60

const blobUploadLimit = createRateLimiter({
  keyPrefix: 'blob_upload',
  maxRequests: 50,
  windowSeconds: 60
})

const blobDownloadLimit = createRateLimiter({
  keyPrefix: 'blob_download',
  maxRequests: 200,
  windowSeconds: 60
})

const chunkUploadLimit = createRateLimiter({
  keyPrefix: 'chunk_upload',
  maxRequests: 100,
  windowSeconds: 60
})

const uploadSessionLimit = createRateLimiter({
  keyPrefix: 'upload_session',
  maxRequests: 20,
  windowSeconds: 60
})

// ============================================================================
// Simple Blob Operations
// ============================================================================

blob.put('/blob/:blob_key', blobUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const blobKey = c.req.param('blob_key')
  const key = generateBlobKey(userId, blobKey, vaultId)

  const body = await c.req.arrayBuffer()
  if (body.byteLength > MAX_FILE_SIZE) {
    throw new AppError(ErrorCodes.VALIDATION_BODY_TOO_LARGE, 'Blob exceeds 500MB limit', 413)
  }

  await assertFileSizeAllowed(c.env.DB, userId, body.byteLength)
  const existing = await c.env.STORAGE.head(key)
  const deltaBytes = body.byteLength - (existing?.size ?? 0)
  if (deltaBytes > 0) {
    await reserveStorage(c.env.DB, userId, deltaBytes)
  }

  let result: R2Object
  try {
    result = await putBlob(c.env.STORAGE, key, body, userId)
  } catch (error) {
    await refundReservation(c.env.DB, userId, deltaBytes, { operation: 'putBlob', userId, key })
    throw error
  }

  if (deltaBytes < 0) {
    await adjustStorageUsed(c.env.DB, userId, deltaBytes)
  }

  return c.json({
    blob_key: blobKey,
    size: body.byteLength,
    etag: result.etag
  })
})

blob.get('/blob/:blob_key', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const blobKey = c.req.param('blob_key')
  const key = generateBlobKey(userId, blobKey, vaultId)

  const rangeHeader = c.req.header('Range')

  if (rangeHeader) {
    const obj = await c.env.STORAGE.get(key, { range: parseRange(rangeHeader) })
    if (!obj) {
      throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Blob not found', 404)
    }
    assertBlobOwner(key, userId)

    const headers = new Headers()
    headers.set('Content-Type', 'application/octet-stream')
    headers.set('Accept-Ranges', 'bytes')
    obj.writeHttpMetadata(headers)

    const body = obj as R2ObjectBody
    const total = obj.size
    const range = obj.range as R2Range & { offset?: number; length?: number }
    const start = range.offset ?? 0
    const end = start + (range.length ?? total) - 1

    headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
    headers.set('Content-Length', String(end - start + 1))

    return new Response(body.body, { status: 206, headers })
  }

  const obj = await getBlob(c.env.STORAGE, key, userId)
  if (!obj) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Blob not found', 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', 'application/octet-stream')
  headers.set('Accept-Ranges', 'bytes')
  headers.set('Content-Length', String(obj.size))
  obj.writeHttpMetadata(headers)

  return new Response(obj.body, { status: 200, headers })
})

blob.delete('/blob/:blob_key', blobUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const blobKey = c.req.param('blob_key')
  const key = generateBlobKey(userId, blobKey, vaultId)

  const existing = await c.env.STORAGE.head(key)
  if (!existing) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Blob not found', 404)
  }
  assertBlobOwner(key, userId)

  const size = existing.size
  await deleteBlob(c.env.STORAGE, key, userId)
  await adjustStorageUsed(c.env.DB, userId, -size)

  return new Response(null, { status: 204 })
})

// ============================================================================
// Chunked Upload Sessions
// ============================================================================

blob.post('/attachments/upload/initiate', uploadSessionLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!

  const body: unknown = await c.req.json()
  const parsed = UploadInitRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid upload init: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  const { attachmentId, filename, totalSize, chunkCount } = parsed.data

  if (totalSize > MAX_FILE_SIZE) {
    throw new AppError(
      ErrorCodes.VALIDATION_BODY_TOO_LARGE,
      `File exceeds ${MAX_FILE_SIZE} byte limit`,
      413
    )
  }

  await assertFileSizeAllowed(c.env.DB, userId, totalSize)
  await reserveStorage(c.env.DB, userId, totalSize)

  const now = Math.floor(Date.now() / 1000)
  const sessionId = crypto.randomUUID()
  const expiresAt = now + UPLOAD_SESSION_TTL

  try {
    await c.env.DB.prepare(
      `INSERT INTO upload_sessions (id, user_id, vault_id, attachment_id, filename, total_size, chunk_count, uploaded_chunks, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    )
      .bind(
        sessionId,
        userId,
        vaultId,
        attachmentId,
        filename,
        totalSize,
        chunkCount,
        expiresAt,
        now
      )
      .run()
  } catch (error) {
    await refundReservation(c.env.DB, userId, totalSize, {
      operation: 'uploadInitiate',
      userId,
      sessionId
    })
    throw error
  }

  return c.json({ sessionId, expiresAt }, 201)
})

blob.put('/attachments/upload/:session_id/chunk/:chunk_index', chunkUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const sessionId = c.req.param('session_id')
  const chunkIndex = parseInt(c.req.param('chunk_index'), 10)

  if (isNaN(chunkIndex) || chunkIndex < 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chunk_index', 400)
  }

  const session = await getUploadSession(c.env.DB, sessionId, userId, vaultId)

  if (chunkIndex >= session.chunk_count) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `chunk_index ${chunkIndex} exceeds chunk_count ${session.chunk_count}`,
      400
    )
  }

  const uploadedChunks = parseUploadedChunks(session.uploaded_chunks)
  if (uploadedChunks.some((c) => c.i === chunkIndex)) {
    throw new AppError(ErrorCodes.UPLOAD_CHUNK_CONFLICT, 'Chunk already uploaded', 409)
  }

  const chunkData = await c.req.arrayBuffer()
  const uploadedBytes = getUploadedByteTotal(uploadedChunks)
  if (uploadedBytes === null || uploadedBytes + chunkData.byteLength > session.total_size) {
    throw new AppError(
      ErrorCodes.STORAGE_FILE_TOO_LARGE,
      'Uploaded chunks exceed declared file size',
      413
    )
  }

  const chunkHash = await sha256Hex(chunkData)

  const chunkR2Key = generateAttachmentChunkKey(userId, vaultId, chunkHash)

  const existingChunk = await c.env.DB.prepare(
    'SELECT id, r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
  )
    .bind(userId, vaultId, chunkHash)
    .first<{ id: string; r2_key: string }>()

  if (existingChunk) {
    await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count + 1 WHERE id = ?')
      .bind(existingChunk.id)
      .run()
  } else {
    await putBlob(c.env.STORAGE, chunkR2Key, chunkData, userId)

    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)`
    )
      .bind(crypto.randomUUID(), chunkHash, userId, vaultId, chunkR2Key, chunkData.byteLength, now)
      .run()
  }

  uploadedChunks.push({ i: chunkIndex, h: chunkHash, b: chunkData.byteLength })
  await c.env.DB.prepare(
    'UPDATE upload_sessions SET uploaded_chunks = ? WHERE id = ? AND user_id = ? AND vault_id = ?'
  )
    .bind(JSON.stringify(uploadedChunks), sessionId, userId, vaultId)
    .run()

  return c.json({
    success: true,
    uploadedChunks: uploadedChunks.length
  })
})

blob.post('/attachments/upload/:session_id/complete', chunkUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId, vaultId)

  const uploadedEntries = parseUploadedChunks(session.uploaded_chunks)
  const uploadedIndices = new Set(uploadedEntries.map((e) => e.i))
  const expected = Array.from({ length: session.chunk_count }, (_, i) => i)
  const missing = expected.filter((i) => !uploadedIndices.has(i))

  if (missing.length > 0) {
    return c.json(
      {
        error: 'Missing chunks',
        missing_chunks: missing
      },
      400
    )
  }

  const actualBytes = getUploadedByteTotal(uploadedEntries)
  if (actualBytes !== session.total_size) {
    throw new AppError(
      ErrorCodes.UPLOAD_INCOMPLETE,
      'Uploaded chunks do not match declared file size',
      400
    )
  }

  const body: unknown = await c.req.json()
  await assertFileSizeAllowed(c.env.DB, userId, session.total_size)
  let manifestKey: string | null = null
  let manifestBytes: Uint8Array | null = null
  let manifestDeltaBytes = 0

  if (body && typeof body === 'object' && 'encryptedManifest' in body) {
    manifestKey = generateAttachmentManifestKey(userId, session.attachment_id, vaultId)
    const manifestData = JSON.stringify(body)
    manifestBytes = new TextEncoder().encode(manifestData)
    await assertFileSizeAllowed(c.env.DB, userId, manifestBytes.byteLength)
    const existingManifest = await c.env.STORAGE.head(manifestKey)
    manifestDeltaBytes = manifestBytes.byteLength - (existingManifest?.size ?? 0)
  }

  if (manifestDeltaBytes > 0) {
    await reserveStorage(c.env.DB, userId, manifestDeltaBytes)
  }

  if (manifestKey && manifestBytes) {
    try {
      await putBlob(c.env.STORAGE, manifestKey, manifestBytes.buffer as ArrayBuffer, userId)
    } catch (error) {
      await refundReservation(c.env.DB, userId, manifestDeltaBytes, {
        operation: 'uploadComplete',
        userId,
        key: manifestKey
      })
      throw error
    }
  }

  if (manifestDeltaBytes < 0) {
    await adjustStorageUsed(c.env.DB, userId, manifestDeltaBytes)
  }

  await c.env.DB.prepare(
    'DELETE FROM upload_sessions WHERE id = ? AND user_id = ? AND vault_id = ?'
  )
    .bind(sessionId, userId, vaultId)
    .run()

  return c.json({
    attachment_id: session.attachment_id,
    manifest_key: generateAttachmentManifestKey(userId, session.attachment_id, vaultId),
    size: session.total_size
  })
})

blob.get('/attachments/upload/:session_id', uploadSessionLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId, vaultId)

  const entries: Array<{ i: number }> = JSON.parse(session.uploaded_chunks)
  return c.json({
    sessionId: session.id,
    attachmentId: session.attachment_id,
    totalSize: session.total_size,
    chunkCount: session.chunk_count,
    uploadedChunks: entries.map((e) => e.i),
    expiresAt: session.expires_at
  })
})

blob.delete('/attachments/upload/:session_id', uploadSessionLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId, vaultId)

  const uploadedEntries: Array<{ i: number; h: string }> = JSON.parse(session.uploaded_chunks)
  const sessionHashes = new Set(uploadedEntries.map((e) => e.h))

  for (const hash of sessionHashes) {
    const chunk = await c.env.DB.prepare(
      'SELECT id, ref_count, r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
    )
      .bind(userId, vaultId, hash)
      .first<{ id: string; ref_count: number; r2_key: string }>()

    if (!chunk) continue

    if (chunk.ref_count <= 1) {
      await deleteBlob(c.env.STORAGE, chunk.r2_key, userId)
      await c.env.DB.prepare('DELETE FROM blob_chunks WHERE id = ?').bind(chunk.id).run()
    } else {
      await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count - 1 WHERE id = ?')
        .bind(chunk.id)
        .run()
    }
  }

  const deleteResult = await c.env.DB.prepare(
    'DELETE FROM upload_sessions WHERE id = ? AND user_id = ? AND vault_id = ?'
  )
    .bind(sessionId, userId, vaultId)
    .run()
  if ((deleteResult.meta.changes ?? 0) > 0) {
    await adjustStorageUsed(c.env.DB, userId, -session.total_size)
  }

  return new Response(null, { status: 204 })
})

// ============================================================================
// Chunk Dedup
// ============================================================================

blob.on('HEAD', '/attachments/chunks/:chunk_hash', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const chunkHash = c.req.param('chunk_hash')

  const chunk = await c.env.DB.prepare(
    'SELECT size_bytes FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
  )
    .bind(userId, vaultId, chunkHash)
    .first<{ size_bytes: number }>()

  if (!chunk) {
    return new Response(null, { status: 404 })
  }

  return new Response(null, {
    status: 200,
    headers: { 'X-Chunk-Size': String(chunk.size_bytes) }
  })
})

blob.get('/attachments/chunks/:chunk_hash', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const chunkHash = c.req.param('chunk_hash')

  const chunk = await c.env.DB.prepare(
    'SELECT r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
  )
    .bind(userId, vaultId, chunkHash)
    .first<{ r2_key: string }>()

  if (!chunk) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Chunk not found', 404)
  }

  const obj = await getBlob(c.env.STORAGE, chunk.r2_key, userId)
  if (!obj) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Chunk data missing from storage', 404)
  }

  const headers = new Headers()
  headers.set('Content-Type', 'application/octet-stream')
  headers.set('Content-Length', String(obj.size))

  return new Response(obj.body, { status: 200, headers })
})

// ============================================================================
// Manifest
// ============================================================================

blob.get('/attachments/:attachment_id/manifest', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const attachmentId = c.req.param('attachment_id')
  const manifestKey = generateAttachmentManifestKey(userId, attachmentId, vaultId)

  const obj = await getBlob(c.env.STORAGE, manifestKey, userId)
  if (!obj) {
    throw new AppError(ErrorCodes.ATTACHMENT_NOT_FOUND, 'Attachment manifest not found', 404)
  }

  const data = await obj.text()
  return c.json(JSON.parse(data))
})

blob.put('/attachments/:attachment_id/manifest', blobUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!
  const attachmentId = c.req.param('attachment_id')
  const manifestKey = generateAttachmentManifestKey(userId, attachmentId, vaultId)

  const body = await c.req.arrayBuffer()
  await assertFileSizeAllowed(c.env.DB, userId, body.byteLength)

  const existing = await c.env.STORAGE.head(manifestKey)
  const deltaBytes = body.byteLength - (existing?.size ?? 0)
  if (deltaBytes > 0) {
    await reserveStorage(c.env.DB, userId, deltaBytes)
  }

  try {
    await putBlob(c.env.STORAGE, manifestKey, body, userId)
  } catch (error) {
    await refundReservation(c.env.DB, userId, deltaBytes, {
      operation: 'manifestPut',
      userId,
      key: manifestKey
    })
    throw error
  }
  if (deltaBytes < 0) {
    await adjustStorageUsed(c.env.DB, userId, deltaBytes)
  }

  return c.json({ manifest_key: manifestKey })
})

// ============================================================================
// Helpers
// ============================================================================

interface UploadSessionRow {
  id: string
  user_id: string
  vault_id: string
  attachment_id: string
  filename: string
  total_size: number
  chunk_count: number
  uploaded_chunks: string
  expires_at: number
  created_at: number
}

interface UploadedChunkEntry {
  i: number
  h: string
  b?: number
}

function parseUploadedChunks(value: string): UploadedChunkEntry[] {
  const parsed = JSON.parse(value) as UploadedChunkEntry[]
  return Array.isArray(parsed) ? parsed : []
}

function getUploadedByteTotal(entries: UploadedChunkEntry[]): number | null {
  let total = 0
  for (const entry of entries) {
    const bytes = entry.b
    if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return null
    total += bytes
  }
  return total
}

async function getUploadSession(
  db: D1Database,
  sessionId: string,
  userId: string,
  vaultId: string
): Promise<UploadSessionRow> {
  const session = await db
    .prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ? AND vault_id = ?')
    .bind(sessionId, userId, vaultId)
    .first<UploadSessionRow>()

  if (!session) {
    throw new AppError(ErrorCodes.UPLOAD_SESSION_NOT_FOUND, 'Upload session not found', 404)
  }

  const now = Math.floor(Date.now() / 1000)
  if (session.expires_at < now) {
    throw new AppError(ErrorCodes.UPLOAD_SESSION_EXPIRED, 'Upload session expired', 410)
  }

  return session
}
function assertBlobOwner(key: string, userId: string): void {
  if (!key.startsWith(`${userId}/`)) {
    throw new AppError(ErrorCodes.STORAGE_UNAUTHORIZED, 'Blob access denied', 403)
  }
}

async function sha256Hex(data: ArrayBuffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', data)
  const bytes = new Uint8Array(hash)
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

function parseRange(header: string): R2Range {
  const match = header.match(/^bytes=(\d+)-(\d*)$/)
  if (!match) {
    return { offset: 0 }
  }
  const offset = parseInt(match[1], 10)
  if (match[2]) {
    const end = parseInt(match[2], 10)
    return { offset, length: end - offset + 1 }
  }
  return { offset }
}
