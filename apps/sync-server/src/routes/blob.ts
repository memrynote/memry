import { Hono } from 'hono'

import { AppError, ErrorCodes } from '../lib/errors'
import { createLogger } from '../lib/logger'
import { authMiddleware } from '../middleware/auth'
import { clientGateMiddleware } from '../middleware/client-gate'
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
import {
  DEFAULT_PRESIGN_TTL_SECONDS,
  assertPresignKeyInVault,
  presignR2Url,
  resolveR2PresignConfig
} from '../services/r2-presign'
import {
  MAX_CHUNK_CRYPTO_OVERHEAD,
  expectedEncryptedTotal,
  getUploadedByteTotal,
  readUploadedChunks,
  type UploadedChunkEntry
} from '../services/upload-size'
import {
  DereferenceRequestSchema,
  DirectChunkEntrySchema,
  PresignBatchRequestSchema,
  UploadInitRequestSchema,
  type DirectChunkEntry
} from '@memry/contracts/blob-api'
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
blob.use('*', clientGateMiddleware)
blob.use('*', paidSyncMiddleware)

const MAX_FILE_SIZE = 500 * 1024 * 1024
const UPLOAD_SESSION_TTL = 24 * 60 * 60

const blobUploadLimit = createRateLimiter({
  keyPrefix: 'blob_upload',
  maxRequests: 50,
  windowSeconds: 60
})

// 600/min (was 200): a bootstrap of an attachment-heavy vault downloads one GET
// per chunk plus manifest reads, and the #1829 download queue paces itself
// against THIS bucket — the ceiling is the throughput knob, and 200/min made a
// 200-chunk vault take a full minute per device pair sharing the per-user
// bucket. 600 matches the crdt_pull ceiling and is still trivial load per
// request (one indexed D1 row + one R2 read). Only the number may change here:
// the key prefix and 60s window are a contract with the client's pacing.
const blobDownloadLimit = createRateLimiter({
  keyPrefix: 'blob_download',
  maxRequests: 600,
  windowSeconds: 60
})

// 300/min (was 100): chunks are ~1MB, so 100/min capped uploads at ~100MB/min
// per user — a single large file saturated the bucket for everything else.
// Each request is one R2 put plus one D1 upsert, so 300/min is still cheap
// server-side while allowing ~3 concurrent large-file uploads. Same contract
// note as blob_download: only the numeric ceiling may change.
const chunkUploadLimit = createRateLimiter({
  keyPrefix: 'chunk_upload',
  maxRequests: 300,
  windowSeconds: 60
})

const uploadSessionLimit = createRateLimiter({
  keyPrefix: 'upload_session',
  maxRequests: 20,
  windowSeconds: 60
})

const dereferenceLimit = createRateLimiter({
  keyPrefix: 'dereference',
  maxRequests: 20,
  windowSeconds: 60
})

// 120/min, additive (#1836): presigning is pure CPU (one HMAC chain per URL)
// plus one indexed D1 read per hash — cheap per request — but every issued URL
// unlocks a direct R2 transfer that bypasses the proxied blob buckets above, so
// issuance stays an order of magnitude under the chunk ceilings it serves. One
// batch arms up to a full manifest's chunks; a bootstrap re-issues at most once
// per TTL window.
const presignLimit = createRateLimiter({
  keyPrefix: 'blob_presign',
  maxRequests: 120,
  windowSeconds: 60
})

// ============================================================================
// Simple Blob Operations
// ============================================================================

// There is deliberately no PUT here. The old simple-blob PUT advertised a 500MB
// ceiling that was unreachable — the body-limit middleware (index.ts) caps blob
// routes at 10MB, so the route's own size check could never fire — and no
// client, current or historical, has ever called it (all attachment uploads go
// through the chunked /attachments/upload sessions below). Removed rather than
// fixed; GET/DELETE stay because item blobs written server-side remain
// addressable.

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

  const { attachmentId, filename, totalSize, chunkCount, encryptedSize, chunkHashes } = parsed.data

  if (totalSize > MAX_FILE_SIZE) {
    throw new AppError(
      ErrorCodes.VALIDATION_BODY_TOO_LARGE,
      `File exceeds ${MAX_FILE_SIZE} byte limit`,
      413
    )
  }

  // encryptedSize drives storage quota, so never trust it blindly: it must be at
  // least the plaintext and no larger than the plaintext plus per-chunk overhead.
  if (
    encryptedSize !== undefined &&
    (encryptedSize < totalSize ||
      encryptedSize > totalSize + MAX_CHUNK_CRYPTO_OVERHEAD * chunkCount)
  ) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      'encryptedSize is not plausible for the declared totalSize and chunkCount',
      400
    )
  }

  // Plan file-size limits apply to the plaintext the user picked; encryption
  // overhead must not eat into their limit. Storage is reserved on ciphertext.
  await assertFileSizeAllowed(c.env.DB, userId, totalSize)

  const expectedEncrypted = expectedEncryptedTotal(totalSize, chunkCount, encryptedSize ?? null)
  await reserveStorage(c.env.DB, userId, expectedEncrypted)

  // Direct-to-R2 opt-in (#1836): the client finished encrypting BEFORE
  // initiating, so it already knows every ciphertext hash and can be handed
  // presigned PUTs here. Additive + graceful: clients that omit chunkHashes
  // (and deployments without the R2 secrets) get exactly the legacy response
  // shape — no chunkUrls key at all.
  let chunkUrls: Record<string, string> | null = null
  if (chunkHashes && chunkHashes.length > 0) {
    if (chunkHashes.length !== chunkCount || new Set(chunkHashes).size !== chunkHashes.length) {
      await refundReservation(c.env.DB, userId, expectedEncrypted, {
        operation: 'uploadInitiate',
        userId
      })
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'chunkHashes must match chunkCount without duplicates',
        400
      )
    }
    const presignConfig = resolveR2PresignConfig(c.env)
    if (presignConfig) {
      chunkUrls = {}
      for (const hash of chunkHashes) {
        // Keys derive from the caller's own scope; the assertion is defense in
        // depth on the exact bytes that go into a signed URL.
        const chunkKey = generateAttachmentChunkKey(userId, vaultId, hash)
        assertPresignKeyInVault(chunkKey, userId, vaultId)
        chunkUrls[hash] = await presignR2Url(presignConfig, { method: 'PUT', key: chunkKey })
      }
    }
    // No credentials → fall through silently: the session is still valid, the
    // client sees no chunkUrls and uploads through the proxied path.
  }

  const now = Math.floor(Date.now() / 1000)
  const sessionId = crypto.randomUUID()
  const expiresAt = now + UPLOAD_SESSION_TTL

  try {
    await c.env.DB.prepare(
      `INSERT INTO upload_sessions (id, user_id, vault_id, attachment_id, filename, total_size, chunk_count, encrypted_size, uploaded_chunks, expires_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, '[]', ?, ?)`
    )
      .bind(
        sessionId,
        userId,
        vaultId,
        attachmentId,
        filename,
        totalSize,
        chunkCount,
        expectedEncrypted,
        expiresAt,
        now
      )
      .run()
  } catch (error) {
    // main's refundReservation (swallows a failed refund so it never masks the
    // real error) with #740's corrected amount: refund exactly what initiate
    // reserved — the encrypted total, not the plaintext totalSize.
    await refundReservation(c.env.DB, userId, expectedEncrypted, {
      operation: 'uploadInitiate',
      userId,
      sessionId
    })
    throw error
  }

  return c.json(
    chunkUrls
      ? {
          sessionId,
          expiresAt,
          chunkUrls,
          urlExpiresAt: Math.floor(Date.now() / 1000) + DEFAULT_PRESIGN_TTL_SECONDS
        }
      : { sessionId, expiresAt },
    201
  )
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

  const uploadedChunks = readSessionChunksOrThrow(session, 'uploadChunk')
  if (uploadedChunks.some((c) => c.i === chunkIndex)) {
    throw new AppError(ErrorCodes.UPLOAD_CHUNK_CONFLICT, 'Chunk already uploaded', 409)
  }

  const chunkData = await c.req.arrayBuffer()
  const uploadedBytes = getUploadedByteTotal(uploadedChunks)
  // Chunks arrive encrypted, so compare against the encrypted total, not total_size.
  const expectedEncrypted = expectedEncryptedTotal(
    session.total_size,
    session.chunk_count,
    session.encrypted_size
  )
  if (uploadedBytes === null || uploadedBytes + chunkData.byteLength > expectedEncrypted) {
    throw new AppError(
      ErrorCodes.STORAGE_FILE_TOO_LARGE,
      'Uploaded chunks exceed declared file size',
      413
    )
  }

  const chunkHash = await sha256Hex(chunkData)

  const chunkR2Key = generateAttachmentChunkKey(userId, vaultId, chunkHash)

  // No dedup lookup: the hash is of the ENCRYPTED chunk, and every encryption
  // uses a fresh random nonce, so the same plaintext never reproduces a hash —
  // a pre-flight SELECT was a guaranteed-miss D1 round trip on every chunk.
  // The write must still be an upsert, not a plain INSERT: blob_chunks has
  // UNIQUE (user_id, vault_id, hash), and a client retrying the SAME encrypted
  // bytes (chunk landed but the session append below failed mid-request) would
  // otherwise 500 on the constraint. On that rare conflict the ref_count
  // increment and the idempotent R2 overwrite of the identical bytes reproduce
  // exactly what the old lookup-then-branch path did.
  await putBlob(c.env.STORAGE, chunkR2Key, chunkData, userId)

  const now = Math.floor(Date.now() / 1000)
  await c.env.DB.prepare(
    `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 1, ?)
     ON CONFLICT (user_id, vault_id, hash) DO UPDATE SET ref_count = ref_count + 1`
  )
    .bind(crypto.randomUUID(), chunkHash, userId, vaultId, chunkR2Key, chunkData.byteLength, now)
    .run()

  // Append atomically in one statement. Clients upload up to MAX_CONCURRENT_CHUNKS
  // chunks in parallel, so a read-modify-write of the whole array here loses
  // entries: each request writes back the snapshot it read, and the last writer
  // wins. The dropped index then fails `complete` with 400 "Missing chunks".
  // `json_insert(x, '$[#]', ...)` appends without re-sending the array we read.
  await c.env.DB.prepare(
    `UPDATE upload_sessions
       SET uploaded_chunks = json_insert(uploaded_chunks, '$[#]', json(?))
     WHERE id = ? AND user_id = ? AND vault_id = ?`
  )
    .bind(
      JSON.stringify({ i: chunkIndex, h: chunkHash, b: chunkData.byteLength }),
      sessionId,
      userId,
      vaultId
    )
    .run()
  uploadedChunks.push({ i: chunkIndex, h: chunkHash, b: chunkData.byteLength })

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

  // One body read feeds both consumers below: the additive directChunks report
  // (#1836) and the encryptedManifest commit. Parsing is additive — an old
  // client sends no directChunks key and takes exactly the legacy path.
  // Additive direct-to-R2 reporting: chunks PUT straight to R2 with presigned
  // URLs never transited the Worker, so nothing appended them to
  // uploaded_chunks yet. They are reconciled here — head-verified against R2 so
  // quota credits only bytes that actually exist — then merged into the session
  // state, after which the legacy completeness/byte-total logic runs unchanged.
  const body: unknown = await c.req.json()
  let directChunks: DirectChunkEntry[] | null = null
  if (body && typeof body === 'object' && 'directChunks' in body) {
    const parsed = DirectChunkEntrySchema.array().safeParse(body.directChunks)
    if (!parsed.success) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `Invalid directChunks: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
        400
      )
    }
    directChunks = parsed.data
  }

  const uploadedEntries = readSessionChunksOrThrow(session, 'uploadComplete')
  if (directChunks && directChunks.length > 0) {
    await reconcileDirectChunks(
      c.env,
      userId,
      vaultId,
      sessionId,
      session,
      uploadedEntries,
      directChunks
    )
  }
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
  if (
    actualBytes !==
    expectedEncryptedTotal(session.total_size, session.chunk_count, session.encrypted_size)
  ) {
    throw new AppError(
      ErrorCodes.UPLOAD_INCOMPLETE,
      'Uploaded chunks do not match declared file size',
      400
    )
  }

  // Plan file-size limit stays on the plaintext size.
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

  const entries = readSessionChunksOrThrow(session, 'uploadStatus')
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

  // Abort RELEASES storage, so unlike the upload paths it must never be blocked
  // by a corrupt column: refusing here would strand the reservation refunded
  // below and leave the user paying for an upload they cancelled, with no way
  // to clear it. Degrade to "no chunks" and still delete the row and refund.
  // The skipped ref_count decrements leave those blob_chunks rows charged until
  // the vault is deleted — a bounded residue, and far better than a session
  // that can never be aborted.
  const abortRead = readUploadedChunks(session.uploaded_chunks)
  if (!abortRead.ok) {
    logger.error('upload session uploaded_chunks is corrupt; aborting without chunk cleanup', {
      operation: 'uploadAbort',
      sessionId: session.id,
      userId,
      vaultId,
      reason: abortRead.reason
    })
  }
  const sessionHashes = new Set(abortRead.entries.map((e) => e.h))

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
    // Refund exactly what initiate reserved — never re-derive it. `encrypted_size`
    // records the reservation; a NULL means the row was written by the old server,
    // which reserved the plaintext total_size. Migration 0002 deliberately does NOT
    // backfill, so those rows stay NULL permanently (and the old worker can still open
    // fresh NULL rows during the migrate-then-deploy window). The `?? total_size`
    // fallback is load-bearing — do not remove it, and do not add a backfill: it would
    // false-413 the last chunk of every in-flight session (see migrations/0002).
    await adjustStorageUsed(c.env.DB, userId, -(session.encrypted_size ?? session.total_size))
  }

  return new Response(null, { status: 204 })
})

// Decrements ref_count for each hash by 1. Decrement-only, on purpose: unlike
// the cancel-session path above, this never eager-deletes R2 — the
// `cleanupOrphanedBlobChunks` cron reaps rows once ref_count <= 0.
blob.post('/attachments/dereference', dereferenceLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!

  const body: unknown = await c.req.json()
  const parsed = DereferenceRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid dereference: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  let dereferenced = 0
  for (const hash of new Set(parsed.data.chunkHashes)) {
    const chunk = await c.env.DB.prepare(
      'SELECT id, ref_count FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash = ?'
    )
      .bind(userId, vaultId, hash)
      .first<{ id: string; ref_count: number }>()
    if (!chunk) continue

    await c.env.DB.prepare('UPDATE blob_chunks SET ref_count = ref_count - 1 WHERE id = ?')
      .bind(chunk.id)
      .run()
    dereferenced++
  }

  return c.json({ dereferenced }, 200)
})

// ============================================================================
// Presigned Direct Transfers (#1836)
// ============================================================================

/**
 * Batch-issues presigned GET URLs for chunks the caller already owns.
 *
 * Scope enforcement is structural: clients send chunk HASHES only — the R2
 * keys come back from D1 rows scoped by `user_id AND vault_id`, exactly the
 * ownership check the proxied chunk GET performs — so a foreign vault's or
 * user's hash is simply "not found". assertPresignKeyInVault runs before
 * signing as defense in depth on the bytes that enter the URL.
 *
 * The manifest endpoint deliberately stays opaque (its body is E2E-encrypted
 * and client-signed), which is why URL issuance is a separate route rather
 * than embedded fields on the manifest response.
 */
blob.post('/attachments/presign-batch', presignLimit, async (c) => {
  const userId = c.get('userId')!
  const vaultId = c.get('vaultId')!

  const config = resolveR2PresignConfig(c.env)
  if (!config) {
    // Typed, permanent signal — old servers answer 404 here instead; clients
    // treat both as "use the proxied path".
    throw new AppError(
      ErrorCodes.STORAGE_PRESIGN_UNAVAILABLE,
      'Presigned R2 transfers are not configured on this deployment',
      501
    )
  }

  const body: unknown = await c.req.json()
  const parsed = PresignBatchRequestSchema.safeParse(body)
  if (!parsed.success) {
    throw new AppError(
      ErrorCodes.VALIDATION_ERROR,
      `Invalid presign batch: ${parsed.error.issues[0]?.message ?? 'validation failed'}`,
      400
    )
  }

  const requested = parsed.data.chunkHashes
  const found = new Map<string, string>()
  // D1 caps bound parameters per statement; 90 leaves headroom under 100 while
  // covering the 1024-hash ceiling in ≤12 indexed lookups.
  const D1_BIND_BATCH = 90
  for (let i = 0; i < requested.length; i += D1_BIND_BATCH) {
    const slice = requested.slice(i, i + D1_BIND_BATCH)
    const placeholders = slice.map(() => '?').join(', ')
    const result = await c.env.DB.prepare(
      `SELECT hash, r2_key FROM blob_chunks WHERE user_id = ? AND vault_id = ? AND hash IN (${placeholders})`
    )
      .bind(userId, vaultId, ...slice)
      .all<{ hash: string; r2_key: string }>()
    for (const row of result.results) found.set(row.hash, row.r2_key)
  }

  if (found.size < new Set(requested).size) {
    throw new AppError(ErrorCodes.STORAGE_BLOB_NOT_FOUND, 'One or more chunks not found', 404)
  }

  const urls: Record<string, string> = {}
  for (const [hash, r2Key] of found) {
    assertPresignKeyInVault(r2Key, userId, vaultId)
    urls[hash] = await presignR2Url(config, { method: 'GET', key: r2Key })
  }

  return c.json({
    urls,
    expiresAt: Math.floor(Date.now() / 1000) + DEFAULT_PRESIGN_TTL_SECONDS
  })
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
  /** NULL for sessions opened before this column existed, or by clients that omit it. */
  encrypted_size: number | null
  uploaded_chunks: string
  expires_at: number
  created_at: number
}

/**
 * Read a session's chunk list for a path that ACQUIRES storage, refusing to
 * continue when the column is corrupt.
 *
 * Degrading a corrupt `uploaded_chunks` to "no chunks" is unsafe here in three
 * separate ways: it reports zero landed bytes, silently resetting the quota
 * ceiling compared on every chunk PUT; it re-opens the duplicate-chunk guard;
 * and at complete it blames the client for chunks it may well have sent. The
 * chunk PUT could not succeed anyway — the `json_insert` append needs the
 * column to be valid JSON — so continuing would merely write the chunk to R2
 * and touch blob_chunks before failing untyped.
 *
 * `uploaded_chunks` is written solely by this server, so a corrupt value is a
 * server fault, not a client one: log it and raise a typed 500 (captured by
 * errorHandler) instead of mis-billing quietly. Aborting the session still
 * works and refunds the reservation, which is the way out.
 */
function readSessionChunksOrThrow(
  session: UploadSessionRow,
  operation: string
): UploadedChunkEntry[] {
  const read = readUploadedChunks(session.uploaded_chunks)
  if (read.ok) return read.entries

  logger.error('upload session uploaded_chunks is corrupt', {
    operation,
    sessionId: session.id,
    userId: session.user_id,
    vaultId: session.vault_id,
    reason: read.reason
  })
  throw new AppError(
    ErrorCodes.INTERNAL_ERROR,
    'Upload session state is corrupt; abort the session and retry the upload',
    500
  )
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

/**
 * Register chunks a client uploaded DIRECT to R2 with presigned PUTs (#1836).
 *
 * These bytes never transited the Worker, so unlike the proxied chunk PUT they
 * arrive here only as claims. Every claim is therefore reconciled before it is
 * credited:
 * - structural guards first (index bounds, duplicate index/hash inside the
 *   report, collision with an already-proxied-registered index),
 * - then an R2 `head` per chunk proving the object exists at the derived key
 *   with EXACTLY the reported byte count — quota is only ever charged for
 *   storage that verifiably exists.
 * Only after all heads pass do the blob_chunks upserts and session appends
 * run, mirroring statement-for-statement what the proxied PUT did per chunk.
 * Merged entries are pushed onto `uploadedEntries`, so the legacy
 * completeness/byte-total checks downstream see one uniform list.
 */
async function reconcileDirectChunks(
  env: { DB: D1Database; STORAGE: R2Bucket },
  userId: string,
  vaultId: string,
  sessionId: string,
  session: UploadSessionRow,
  uploadedEntries: UploadedChunkEntry[],
  directChunks: DirectChunkEntry[]
): Promise<void> {
  const knownIndices = new Set(uploadedEntries.map((e) => e.i))
  const knownHashes = new Set(uploadedEntries.map((e) => e.h))

  const pending: DirectChunkEntry[] = []
  const pendingIndices = new Set<number>()
  const pendingHashes = new Set<string>()
  for (const entry of directChunks) {
    if (entry.i >= session.chunk_count) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        `direct chunk index ${entry.i} exceeds chunk_count ${session.chunk_count}`,
        400
      )
    }
    if (pendingIndices.has(entry.i) || pendingHashes.has(entry.h)) {
      throw new AppError(
        ErrorCodes.VALIDATION_ERROR,
        'directChunks contains a duplicate index or hash',
        400
      )
    }
    // A proxied retry that landed after a "failed" direct PUT wins by
    // registration order; the stale direct claim for that index is ignored.
    if (knownIndices.has(entry.i)) continue
    if (knownHashes.has(entry.h)) {
      throw new AppError(
        ErrorCodes.UPLOAD_CHUNK_CONFLICT,
        `chunk ${entry.h} was already registered under a different index`,
        409
      )
    }
    pendingIndices.add(entry.i)
    pendingHashes.add(entry.h)
    pending.push(entry)
  }

  const now = Math.floor(Date.now() / 1000)
  const verified: Array<{ entry: DirectChunkEntry; key: string }> = []
  for (const entry of pending) {
    const key = generateAttachmentChunkKey(userId, vaultId, entry.h)
    assertPresignKeyInVault(key, userId, vaultId)
    const obj = await env.STORAGE.head(key)
    if (!obj) {
      throw new AppError(
        ErrorCodes.UPLOAD_INCOMPLETE,
        `Direct-uploaded chunk ${entry.h} is missing from storage`,
        400
      )
    }
    if (obj.size !== entry.b) {
      throw new AppError(
        ErrorCodes.UPLOAD_INCOMPLETE,
        `Direct-uploaded chunk ${entry.h} size mismatch: stored ${obj.size}, reported ${entry.b}`,
        400
      )
    }
    verified.push({ entry, key })
  }

  for (const { entry, key } of verified) {
    await env.DB.prepare(
      `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT (user_id, vault_id, hash) DO UPDATE SET ref_count = ref_count + 1`
    )
      .bind(crypto.randomUUID(), entry.h, userId, vaultId, key, entry.b, now)
      .run()
    await env.DB.prepare(
      `UPDATE upload_sessions
         SET uploaded_chunks = json_insert(uploaded_chunks, '$[#]', json(?))
       WHERE id = ? AND user_id = ? AND vault_id = ?`
    )
      .bind(JSON.stringify({ i: entry.i, h: entry.h, b: entry.b }), sessionId, userId, vaultId)
      .run()
    uploadedEntries.push({ i: entry.i, h: entry.h, b: entry.b })
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
