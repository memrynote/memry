import { describe, it, expect, vi, beforeEach } from 'vitest'

import { AppError, ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../services/blob', () => ({
  generateAttachmentChunkKey: (userId: string, vaultId: string, chunkHash: string) =>
    `${userId}/vaults/${vaultId}/chunks/${chunkHash}`,
  generateAttachmentManifestKey: (userId: string, attachmentId: string, vaultId: string) =>
    `${userId}/vaults/${vaultId}/attachments/${attachmentId}/manifest`,
  generateBlobKey: (userId: string, itemId: string, vaultId: string) =>
    `${userId}/vaults/${vaultId}/items/${itemId}`,
  putBlob: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
  getBlob: vi.fn(),
  deleteBlob: vi.fn().mockResolvedValue(undefined),
  parseUploadedChunks: (value: string) => {
    const parsed = JSON.parse(value)
    return Array.isArray(parsed) ? parsed : []
  },
  getUploadedByteTotal: (entries: Array<{ b?: number }>) => {
    let total = 0
    for (const entry of entries) {
      const bytes = entry.b
      if (typeof bytes !== 'number' || !Number.isInteger(bytes) || bytes < 0) return null
      total += bytes
    }
    return total
  }
}))

vi.mock('../services/quota', () => ({
  adjustStorageUsed: vi.fn().mockResolvedValue(undefined),
  checkQuota: vi.fn().mockResolvedValue(undefined),
  reserveStorage: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/entitlements', () => ({
  assertFileSizeAllowed: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../middleware/auth', () => ({
  authMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('userId', 'user-1')
    c.set('deviceId', 'device-1')
    c.set('vaultId', 'vault-1')
    await next()
  })
}))

vi.mock('../middleware/paid-sync', () => ({
  paidSyncMiddleware: vi.fn().mockImplementation(async (_c: any, next: any) => {
    await next()
  })
}))

const { blobRateLimiterOptions } = vi.hoisted(() => ({
  blobRateLimiterOptions: [] as Array<{
    keyPrefix: string
    maxRequests: number
    windowSeconds: number
  }>
}))

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi
    .fn()
    .mockImplementation(
      (options: { keyPrefix: string; maxRequests: number; windowSeconds: number }) => {
        blobRateLimiterOptions.push(options)
        return vi.fn().mockImplementation(async (_c: any, next: any) => {
          await next()
        })
      }
    )
}))

import {
  createApp,
  createEnv,
  createR2Object,
  createSession as baseSession,
  type MockDbState
} from '../__mocks__/blob-route-harness'
import { putBlob, getBlob, deleteBlob } from '../services/blob'
import { assertFileSizeAllowed } from '../services/entitlements'
import { adjustStorageUsed, reserveStorage } from '../services/quota'
import { CHUNK_CRYPTO_OVERHEAD } from '../services/upload-size'

// 10 plaintext bytes across 2 chunks => 10 + 40*2 bytes stored.
const UPLOAD_INIT_ENCRYPTED_SIZE = 10 + CHUNK_CRYPTO_OVERHEAD * 2

// A fully-uploaded 2-chunk session as the current server writes it. Chunks go on
// the wire encrypted: nonce(24) + ciphertext(plaintext + 16-byte tag) — fixtures
// must honour that, so a 5-byte plaintext chunk uploads as 45 bytes, and
// encrypted_size records what initiate reserved.
const createSession = (overrides: Record<string, unknown> = {}) =>
  baseSession({
    total_size: 10,
    chunk_count: 2,
    encrypted_size: UPLOAD_INIT_ENCRYPTED_SIZE,
    uploaded_chunks: JSON.stringify([
      { i: 0, h: 'hash-0', b: 5 + CHUNK_CRYPTO_OVERHEAD },
      { i: 1, h: 'hash-1', b: 5 + CHUNK_CRYPTO_OVERHEAD }
    ]),
    ...overrides
  })

const uploadInitBody = {
  attachmentId: 'att-1',
  filename: 'file.bin',
  totalSize: 10,
  chunkCount: 2
}

describe('blob routes', () => {
  let app: ReturnType<typeof createApp>
  let state: MockDbState
  let env: ReturnType<typeof createEnv>

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(putBlob).mockResolvedValue({ etag: 'etag-1' } as any)
    vi.mocked(getBlob).mockResolvedValue(createR2Object() as any)
    vi.mocked(deleteBlob).mockResolvedValue(undefined)
    vi.mocked(assertFileSizeAllowed).mockResolvedValue(undefined)
    vi.mocked(adjustStorageUsed).mockResolvedValue(undefined)
    vi.mocked(reserveStorage).mockResolvedValue(undefined)
    app = createApp()
    state = {
      session: createSession(),
      chunk: {
        id: 'chunk-1',
        r2_key: 'user-1/vaults/vault-1/chunks/hash-0',
        size_bytes: 5,
        ref_count: 1
      },
      statements: []
    }
    env = createEnv(state)
  })

  it('rejects the removed simple-blob PUT path', async () => {
    // The simple-blob PUT was dead as written (its 500MB check sat behind the
    // 10MB body-limit middleware) and no client ever called it — it must stay
    // gone. GET/DELETE for item blobs remain.
    const res = await app.request('/blob/blob-1', { method: 'PUT', body: 'hello' }, env)

    expect(res.status).toBe(404)
    expect(putBlob).not.toHaveBeenCalled()
    expect(reserveStorage).not.toHaveBeenCalled()
  })

  it('surfaces the original storage error when the quota refund also fails', async () => {
    // #given the reservation succeeds, the put fails with a typed error, and the
    // refund D1 write ALSO fails — the compound outage the refund must survive.
    vi.mocked(env.STORAGE.head).mockResolvedValueOnce(null)
    vi.mocked(putBlob).mockRejectedValueOnce(
      new AppError(ErrorCodes.STORAGE_UPLOAD_FAILED, 'Blob upload failed', 500)
    )
    vi.mocked(adjustStorageUsed).mockRejectedValueOnce(
      new Error('D1_ERROR: Network connection lost.')
    )

    const res = await app.request(
      '/attachments/att-1/manifest',
      { method: 'PUT', body: 'manifest' },
      env
    )

    // #then the refund failure must not replace the real cause: the client sees
    // the typed storage error, not an UNHANDLED_ERROR leaked from the refund.
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({
      error: { code: ErrorCodes.STORAGE_UPLOAD_FAILED }
    })
    // the refund was still attempted (its failure is swallowed + logged)
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -8)
  })

  it('downloads a simple blob with content length headers', async () => {
    vi.mocked(getBlob).mockResolvedValueOnce(createR2Object({ size: 7 }) as any)

    const res = await app.request('/blob/blob-1', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('7')
    expect(getBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/items/blob-1',
      'user-1'
    )
  })

  it('downloads a byte range directly from R2', async () => {
    const res = await app.request(
      '/blob/blob-1',
      { method: 'GET', headers: { Range: 'bytes=1-3' } },
      env
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 1-3/5')
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/vaults/vault-1/items/blob-1', {
      range: { offset: 1, length: 3 }
    })
  })

  it('returns 404 when a ranged blob read misses R2', async () => {
    vi.mocked(env.STORAGE.get).mockResolvedValueOnce(null)

    const res = await app.request(
      '/blob/missing',
      { method: 'GET', headers: { Range: 'bytes=1-3' } },
      env
    )

    expect(res.status).toBe(404)
  })

  it('supports open-ended and invalid range headers through the parser fallback', async () => {
    await app.request('/blob/blob-1', { method: 'GET', headers: { Range: 'bytes=2-' } }, env)
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/vaults/vault-1/items/blob-1', {
      range: { offset: 2 }
    })

    await app.request('/blob/blob-1', { method: 'GET', headers: { Range: 'bad-range' } }, env)
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/vaults/vault-1/items/blob-1', {
      range: { offset: 0 }
    })
  })

  it('returns 404 for missing simple blob downloads', async () => {
    vi.mocked(getBlob).mockResolvedValueOnce(null)

    const res = await app.request('/blob/missing', { method: 'GET' }, env)

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.STORAGE_BLOB_NOT_FOUND
    )
  })

  it('deletes a simple blob and subtracts storage usage', async () => {
    const res = await app.request('/blob/blob-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/items/blob-1',
      'user-1'
    )
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -5)
  })

  it('returns 404 when deleting a missing simple blob', async () => {
    vi.mocked(env.STORAGE.head).mockResolvedValueOnce(null)

    const res = await app.request('/blob/missing', { method: 'DELETE' }, env)

    expect(res.status).toBe(404)
  })

  it('initiates a chunked upload session after quota validation', async () => {
    const res = await app.request(
      '/attachments/upload/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(uploadInitBody)
      },
      env
    )

    expect(res.status).toBe(201)
    expect((await res.json()) as Record<string, unknown>).toEqual({
      sessionId: expect.any(String),
      expiresAt: expect.any(Number)
    })
    // storage is reserved on ciphertext, the plan limit is checked on plaintext
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', UPLOAD_INIT_ENCRYPTED_SIZE)
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 10)
    expect(
      state.statements.some(
        (entry) =>
          entry.sql.includes('INSERT INTO upload_sessions') && entry.bindings.includes('vault-1')
      )
    ).toBe(true)
  })

  it('rejects invalid upload initiation payloads', async () => {
    const res = await app.request(
      '/attachments/upload/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...uploadInitBody, chunkCount: 0 })
      },
      env
    )

    expect(res.status).toBe(400)
  })

  it('rejects upload sessions over the maximum file size', async () => {
    const res = await app.request(
      '/attachments/upload/initiate',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...uploadInitBody, totalSize: 500 * 1024 * 1024 + 1 })
      },
      env
    )

    expect(res.status).toBe(413)
  })

  it('uploads a new chunk and records its hash in the session', async () => {
    state.session = createSession({ uploaded_chunks: '[]' })

    const res = await app.request(
      '/attachments/upload/session-1/chunk/0',
      {
        method: 'PUT',
        body: 'chunk-data'
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, uploadedChunks: 1 })
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      expect.stringMatching(/^user-1\/vaults\/vault-1\/chunks\/[a-f0-9]{64}$/),
      expect.any(ArrayBuffer),
      'user-1'
    )
  })

  it('rejects a chunk that would exceed the declared upload size', async () => {
    // 10 plaintext bytes over 2 chunks => 90 bytes allowed. 45 already up, 50 more overruns.
    state.session = createSession({
      total_size: 10,
      uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 5 + CHUNK_CRYPTO_OVERHEAD }])
    })

    const res = await app.request(
      '/attachments/upload/session-1/chunk/1',
      {
        method: 'PUT',
        body: new Uint8Array(50)
      },
      env
    )

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.STORAGE_FILE_TOO_LARGE
    )
  })

  it('stores a chunk with a single upsert and no dedup lookup', async () => {
    // Dedup keyed on the hash of the ENCRYPTED chunk, which a fresh random
    // nonce makes unique per encryption — the pre-flight SELECT could never
    // hit and was a wasted D1 round trip per chunk. The write is one upsert:
    // its ON CONFLICT arm still increments ref_count for the rare
    // same-bytes retry, keeping the UNIQUE (user_id, vault_id, hash)
    // constraint from turning that retry into a 500.
    state.session = createSession({ uploaded_chunks: '[]' })

    const res = await app.request(
      '/attachments/upload/session-1/chunk/0',
      {
        method: 'PUT',
        body: 'chunk-data'
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ success: true, uploadedChunks: 1 })
    expect(putBlob).toHaveBeenCalledTimes(1)
    expect(
      state.statements.some((entry) => entry.sql.includes('SELECT id, r2_key FROM blob_chunks'))
    ).toBe(false)
    const insert = state.statements.find((entry) => entry.sql.includes('INSERT INTO blob_chunks'))
    expect(insert?.sql).toContain(
      'ON CONFLICT (user_id, vault_id, hash) DO UPDATE SET ref_count = ref_count + 1'
    )
  })

  it('rejects duplicate and out-of-range chunks', async () => {
    let res = await app.request(
      '/attachments/upload/session-1/chunk/0',
      { method: 'PUT', body: 'x' },
      env
    )
    expect(res.status).toBe(409)

    state.session = createSession({ uploaded_chunks: '[]' })
    res = await app.request(
      '/attachments/upload/session-1/chunk/9',
      { method: 'PUT', body: 'x' },
      env
    )
    expect(res.status).toBe(400)
  })

  it('rejects invalid chunk index values before loading the session', async () => {
    let res = await app.request(
      '/attachments/upload/session-1/chunk/not-a-number',
      {
        method: 'PUT',
        body: 'x'
      },
      env
    )
    expect(res.status).toBe(400)

    res = await app.request(
      '/attachments/upload/session-1/chunk/-1',
      {
        method: 'PUT',
        body: 'x'
      },
      env
    )
    expect(res.status).toBe(400)
  })

  it('reports missing chunks on complete', async () => {
    state.session = createSession({ uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0' }]) })

    const res = await app.request(
      '/attachments/upload/session-1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      },
      env
    )

    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'Missing chunks', missing_chunks: [1] })
  })

  it('rejects completion when uploaded chunk bytes are only the plaintext total', async () => {
    // 200 plaintext bytes over 2 chunks must arrive as 200 + 40*2 = 280 bytes.
    // These two 100-byte chunks are individually plausible on the wire (a chunk
    // cannot be under 40 bytes) and sum to exactly the plaintext total — the
    // shape a client produces when it is NOT counting encryption overhead. It
    // must be rejected, which is only true if `complete` compares against the
    // encrypted total rather than session.total_size.
    state.session = createSession({
      total_size: 200,
      encrypted_size: 200 + CHUNK_CRYPTO_OVERHEAD * 2,
      uploaded_chunks: JSON.stringify([
        { i: 0, h: 'hash-0', b: 100 },
        { i: 1, h: 'hash-1', b: 100 }
      ])
    })

    const res = await app.request(
      '/attachments/upload/session-1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      },
      env
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.UPLOAD_INCOMPLETE
    )
  })

  it('completes an upload, writes the encrypted manifest, and clears the session', async () => {
    vi.mocked(env.STORAGE.head).mockResolvedValueOnce(null)
    const manifestSize = new TextEncoder().encode(
      JSON.stringify({ encryptedManifest: 'manifest' })
    ).byteLength

    const res = await app.request(
      '/attachments/upload/session-1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ encryptedManifest: 'manifest' })
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      attachment_id: 'att-1',
      manifest_key: 'user-1/vaults/vault-1/attachments/att-1/manifest',
      size: 10
    })
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 10)
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', manifestSize)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', manifestSize)
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/attachments/att-1/manifest',
      expect.any(ArrayBuffer),
      'user-1'
    )
  })

  it('completes an upload without writing a manifest when encryptedManifest is absent', async () => {
    const res = await app.request(
      '/attachments/upload/session-1/complete',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({})
      },
      env
    )

    expect(res.status).toBe(200)
    expect(putBlob).not.toHaveBeenCalled()
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 10)
    expect(reserveStorage).not.toHaveBeenCalledWith(env.DB, 'user-1', 10)
  })

  it('returns upload session progress', async () => {
    const res = await app.request('/attachments/upload/session-1', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      sessionId: 'session-1',
      attachmentId: 'att-1',
      totalSize: 10,
      chunkCount: 2,
      uploadedChunks: [0, 1],
      expiresAt: expect.any(Number)
    })
  })

  it('cancels an upload and deletes single-reference chunks', async () => {
    state.chunk = {
      id: 'chunk-1',
      ref_count: 1,
      r2_key: 'user-1/vaults/vault-1/chunks/hash-0'
    }

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/chunks/hash-0',
      'user-1'
    )
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -UPLOAD_INIT_ENCRYPTED_SIZE)
    expect(
      state.statements.some((entry) => entry.sql.includes('DELETE FROM upload_sessions'))
    ).toBe(true)
  })

  it('cancels an upload by decrementing shared chunks', async () => {
    state.chunk = {
      id: 'chunk-1',
      ref_count: 2,
      r2_key: 'user-1/vaults/vault-1/chunks/hash-0'
    }

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).not.toHaveBeenCalled()
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -UPLOAD_INIT_ENCRYPTED_SIZE)
    expect(state.statements.some((entry) => entry.sql.includes('ref_count = ref_count - 1'))).toBe(
      true
    )
  })

  it('cancels an upload even when chunk metadata is already gone', async () => {
    state.chunk = null

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).not.toHaveBeenCalled()
    expect(
      state.statements.some((entry) => entry.sql.includes('DELETE FROM upload_sessions'))
    ).toBe(true)
  })

  it('dereferences chunks by decrementing ref_count per hash', async () => {
    state.chunksByHash = {
      h1: { id: 'chunk-h1', ref_count: 2 },
      h2: { id: 'chunk-h2', ref_count: 1 }
    }

    const res = await app.request(
      '/attachments/dereference',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkHashes: ['h1', 'h2'] })
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dereferenced: 2 })

    const decrements = state.statements.filter((entry) =>
      entry.sql.includes('UPDATE blob_chunks SET ref_count = ref_count - 1')
    )
    expect(decrements).toHaveLength(2)
    expect(decrements.map((entry) => entry.bindings)).toEqual(
      expect.arrayContaining([['chunk-h1'], ['chunk-h2']])
    )
  })

  it('skips a hash that has no matching chunk instead of erroring (idempotent dereference)', async () => {
    // The hash is not seeded in chunksByHash, so the route's lookup misses —
    // dereferencing a hash already gone must not error.
    state.chunksByHash = {}

    const res = await app.request(
      '/attachments/dereference',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkHashes: ['already-gone'] })
      },
      env
    )

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ dereferenced: 0 })

    const decrements = state.statements.filter((entry) =>
      entry.sql.includes('UPDATE blob_chunks SET ref_count = ref_count - 1')
    )
    expect(decrements).toHaveLength(0)
  })

  it('rejects an empty chunkHashes array', async () => {
    const res = await app.request(
      '/attachments/dereference',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chunkHashes: [] })
      },
      env
    )

    expect(res.status).toBe(400)
  })

  it('checks and downloads deduplicated chunks', async () => {
    let res = await app.request('/attachments/chunks/hash-0', { method: 'HEAD' }, env)
    expect(res.status).toBe(200)

    res = await app.request('/attachments/chunks/hash-0', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(getBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/chunks/hash-0',
      'user-1'
    )
  })

  it('returns 404 for missing chunk metadata or missing chunk data', async () => {
    state.chunk = null
    let res = await app.request('/attachments/chunks/missing', { method: 'HEAD' }, env)
    expect(res.status).toBe(404)

    res = await app.request('/attachments/chunks/missing', { method: 'GET' }, env)
    expect(res.status).toBe(404)

    state.chunk = { r2_key: 'user-1/vaults/vault-1/chunks/hash-0' }
    vi.mocked(getBlob).mockResolvedValueOnce(null)
    res = await app.request('/attachments/chunks/hash-0', { method: 'GET' }, env)
    expect(res.status).toBe(404)
  })

  it('gets and puts attachment manifests', async () => {
    let res = await app.request('/attachments/att-1/manifest', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ chunks: ['a'] })

    res = await app.request('/attachments/att-1/manifest', { method: 'PUT', body: 'manifest' }, env)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      manifest_key: 'user-1/vaults/vault-1/attachments/att-1/manifest'
    })
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/vaults/vault-1/attachments/att-1/manifest',
      expect.any(ArrayBuffer),
      'user-1'
    )
    expect(env.STORAGE.head).toHaveBeenCalledWith(
      'user-1/vaults/vault-1/attachments/att-1/manifest'
    )
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 8)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', 3)
  })

  it('returns 404 when a manifest is missing', async () => {
    vi.mocked(getBlob).mockResolvedValueOnce(null)

    const res = await app.request('/attachments/missing/manifest', { method: 'GET' }, env)

    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.ATTACHMENT_NOT_FOUND
    )
  })

  it('returns session errors for missing or expired upload sessions', async () => {
    state.session = null
    let res = await app.request('/attachments/upload/missing', { method: 'GET' }, env)
    expect(res.status).toBe(404)

    state.session = createSession({ expires_at: Math.floor(Date.now() / 1000) - 1 })
    res = await app.request('/attachments/upload/expired', { method: 'GET' }, env)
    expect(res.status).toBe(410)
  })

  describe('rate limit wiring', () => {
    const optionsFor = (keyPrefix: string) =>
      blobRateLimiterOptions.find((o) => o.keyPrefix === keyPrefix)

    it('gives blob_download attachment-bootstrap throughput without renaming the bucket', () => {
      // #then — the #1829 download queue paces against this exact bucket key
      // and window; only the numeric ceiling is allowed to move.
      expect(optionsFor('blob_download')).toMatchObject({ maxRequests: 600, windowSeconds: 60 })
    })

    it('gives chunk_upload room for concurrent large-file uploads', () => {
      // #then — ~1MB chunks, so 300/min ≈ 300MB/min per user instead of 100.
      expect(optionsFor('chunk_upload')).toMatchObject({ maxRequests: 300, windowSeconds: 60 })
    })
  })
})
