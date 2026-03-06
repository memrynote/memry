import { Hono } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { authMiddleware } from '../middleware/auth'
import { createRateLimiter } from '../middleware/rate-limit'
import { putBlob, getBlob, deleteBlob } from '../services/blob'
import { checkQuota } from '../services/quota'
import { UploadInitRequestSchema } from '@memry/contracts/blob-api'
import type { AppContext } from '../types'

export const blob = new Hono<AppContext>()

blob.use('*', authMiddleware)

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
  const blobKey = c.req.param('blob_key')

  const body = await c.req.arrayBuffer()
  if (body.byteLength > MAX_FILE_SIZE) {
    throw new AppError(ErrorCodes.VALIDATION_BODY_TOO_LARGE, 'Blob exceeds 500MB limit', 413)
  }

  await checkQuota(c.env.DB, userId, body.byteLength)

  const key = `${userId}/items/${blobKey}`
  const result = await putBlob(c.env.STORAGE, key, body, userId)

  await updateStorageUsed(c.env.DB, userId, body.byteLength)

  return c.json({
    blob_key: blobKey,
    size: body.byteLength,
    etag: result.etag
  })
})

blob.get('/blob/:blob_key', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const blobKey = c.req.param('blob_key')
  const key = `${userId}/items/${blobKey}`

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
  const blobKey = c.req.param('blob_key')
  const key = `${userId}/items/${blobKey}`

  const existing = await c.env.STORAGE.head(key)
  if (!existing) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'Blob not found', 404)
  }
  assertBlobOwner(key, userId)

  const size = existing.size
  await deleteBlob(c.env.STORAGE, key, userId)
  await updateStorageUsed(c.env.DB, userId, -size)

  return new Response(null, { status: 204 })
})

// ============================================================================
// Chunked Upload Sessions
// ============================================================================

blob.post('/attachments/upload/initiate', uploadSessionLimit, async (c) => {
  const userId = c.get('userId')!

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

  await checkQuota(c.env.DB, userId, totalSize)

  const now = Math.floor(Date.now() / 1000)
  const sessionId = crypto.randomUUID()
  const expiresAt = now + UPLOAD_SESSION_TTL

  await c.env.DB.prepare(
    `INSERT INTO upload_sessions (id, user_id, attachment_id, filename, total_size, chunk_count, uploaded_chunks, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, '[]', ?, ?)`
  )
    .bind(sessionId, userId, attachmentId, filename, totalSize, chunkCount, expiresAt, now)
    .run()

  return c.json({ sessionId, expiresAt }, 201)
})

blob.put('/attachments/upload/:session_id/chunk/:chunk_index', chunkUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const sessionId = c.req.param('session_id')
  const chunkIndex = parseInt(c.req.param('chunk_index'), 10)

  if (isNaN(chunkIndex) || chunkIndex < 0) {
    throw new AppError(ErrorCodes.VALIDATION_ERROR, 'Invalid chunk_index', 400)
  }

  const session = await getUploadSession(c.env.DB, sessionId, userId)

  if (chunkIndex >= session.chunk_count) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `chunk_index ${chunkIndex} exceeds chunk_count ${session.chunk_count}`,
      400
    )
  }

  const uploadedChunks: Array<{ i: number; h: string }> = JSON.parse(session.uploaded_chunks)
  if (uploadedChunks.some((c) => c.i === chunkIndex)) {
    throw new AppError(ErrorCodes.UPLOAD_CHUNK_CONFLICT, 'Chunk already uploaded', 409)
  }

  const chunkData = await c.req.arrayBuffer()
  const chunkHash = await sha256Hex(chunkData)

  const chunkR2Key = `${userId}/${chunkHash}`

  const existingChunk = await c.env.DB.prepare(
    'SELECT id, r2_key FROM blob_chunks WHERE user_id = ? AND hash = ?'
  )
    .bind(userId, chunkHash)
    .first<{ id: string; r2_key: string }>()

  if (existingChunk) {
    await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count + 1 WHERE id = ?')
      .bind(existingChunk.id)
      .run()
  } else {
    await putBlob(c.env.STORAGE, chunkR2Key, chunkData, userId)

    const now = Math.floor(Date.now() / 1000)
    await c.env.DB.prepare(
      `INSERT INTO blob_chunks (id, hash, user_id, r2_key, size_bytes, ref_count, created_at)
         VALUES (?, ?, ?, ?, ?, 1, ?)`
    )
      .bind(crypto.randomUUID(), chunkHash, userId, chunkR2Key, chunkData.byteLength, now)
      .run()
  }

  uploadedChunks.push({ i: chunkIndex, h: chunkHash })
  await c.env.DB.prepare('UPDATE upload_sessions SET uploaded_chunks = ? WHERE id = ?')
    .bind(JSON.stringify(uploadedChunks), sessionId)
    .run()

  return c.json({
    success: true,
    uploadedChunks: uploadedChunks.length
  })
})

blob.post('/attachments/upload/:session_id/complete', chunkUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId)

  const uploadedEntries: Array<{ i: number; h: string }> = JSON.parse(session.uploaded_chunks)
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

  const body: unknown = await c.req.json()
  if (body && typeof body === 'object' && 'encryptedManifest' in body) {
    const manifestKey = `${userId}/meta/${session.attachment_id}`
    const manifestData = JSON.stringify(body)
    const manifestBytes = new TextEncoder().encode(manifestData)
    await putBlob(c.env.STORAGE, manifestKey, manifestBytes.buffer as ArrayBuffer, userId)
  }

  await updateStorageUsed(c.env.DB, userId, session.total_size)

  await c.env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?').bind(sessionId).run()

  return c.json({
    attachment_id: session.attachment_id,
    manifest_key: `${userId}/meta/${session.attachment_id}`,
    size: session.total_size
  })
})

blob.get('/attachments/upload/:session_id', uploadSessionLimit, async (c) => {
  const userId = c.get('userId')!
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId)

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
  const sessionId = c.req.param('session_id')

  const session = await getUploadSession(c.env.DB, sessionId, userId)

  const uploadedEntries: Array<{ i: number; h: string }> = JSON.parse(session.uploaded_chunks)
  const sessionHashes = new Set(uploadedEntries.map((e) => e.h))

  for (const hash of sessionHashes) {
    const chunk = await c.env.DB.prepare(
      'SELECT id, ref_count FROM blob_chunks WHERE user_id = ? AND hash = ?'
    )
      .bind(userId, hash)
      .first<{ id: string; ref_count: number }>()

    if (!chunk) continue

    if (chunk.ref_count <= 1) {
      await deleteBlob(c.env.STORAGE, `${userId}/${hash}`, userId)
      await c.env.DB.prepare('DELETE FROM blob_chunks WHERE id = ?').bind(chunk.id).run()
    } else {
      await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count - 1 WHERE id = ?')
        .bind(chunk.id)
        .run()
    }
  }

  await c.env.DB.prepare('DELETE FROM upload_sessions WHERE id = ?').bind(sessionId).run()

  return new Response(null, { status: 204 })
})

// ============================================================================
// Chunk Dedup
// ============================================================================

blob.on('HEAD', '/attachments/chunks/:chunk_hash', blobDownloadLimit, async (c) => {
  const userId = c.get('userId')!
  const chunkHash = c.req.param('chunk_hash')

  const chunk = await c.env.DB.prepare(
    'SELECT size_bytes FROM blob_chunks WHERE user_id = ? AND hash = ?'
  )
    .bind(userId, chunkHash)
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
  const chunkHash = c.req.param('chunk_hash')

  const chunk = await c.env.DB.prepare(
    'SELECT r2_key FROM blob_chunks WHERE user_id = ? AND hash = ?'
  )
    .bind(userId, chunkHash)
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
  const attachmentId = c.req.param('attachment_id')
  const manifestKey = `${userId}/meta/${attachmentId}`

  const obj = await getBlob(c.env.STORAGE, manifestKey, userId)
  if (!obj) {
    throw new AppError(ErrorCodes.ATTACHMENT_NOT_FOUND, 'Attachment manifest not found', 404)
  }

  const data = await obj.text()
  return c.json(JSON.parse(data))
})

blob.put('/attachments/:attachment_id/manifest', blobUploadLimit, async (c) => {
  const userId = c.get('userId')!
  const attachmentId = c.req.param('attachment_id')
  const manifestKey = `${userId}/meta/${attachmentId}`

  const body = await c.req.arrayBuffer()
  await putBlob(c.env.STORAGE, manifestKey, body, userId)

  return c.json({ manifest_key: manifestKey })
})

// ============================================================================
// Helpers
// ============================================================================

interface UploadSessionRow {
  id: string
  user_id: string
  attachment_id: string
  filename: string
  total_size: number
  chunk_count: number
  uploaded_chunks: string
  expires_at: number
  created_at: number
}

async function getUploadSession(
  db: D1Database,
  sessionId: string,
  userId: string
): Promise<UploadSessionRow> {
  const session = await db
    .prepare('SELECT * FROM upload_sessions WHERE id = ? AND user_id = ?')
    .bind(sessionId, userId)
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

async function updateStorageUsed(
  db: D1Database,
  userId: string,
  deltaBytes: number
): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET storage_used = MAX(0, storage_used + ?), updated_at = ? WHERE id = ?`
    )
    .bind(deltaBytes, Math.floor(Date.now() / 1000), userId)
    .run()
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
