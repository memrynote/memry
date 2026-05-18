import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes, errorHandler } from '../lib/errors'
import type { AppContext } from '../types'

vi.mock('../services/blob', () => ({
  putBlob: vi.fn().mockResolvedValue({ etag: 'etag-1' }),
  getBlob: vi.fn(),
  deleteBlob: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/quota', () => ({
  checkQuota: vi.fn().mockResolvedValue(undefined)
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

vi.mock('../middleware/rate-limit', () => ({
  createRateLimiter: vi.fn().mockReturnValue(
    vi.fn().mockImplementation(async (_c: any, next: any) => {
      await next()
    })
  )
}))

import { blob } from './blob'
import { putBlob, getBlob, deleteBlob } from '../services/blob'
import { assertFileSizeAllowed } from '../services/entitlements'
import { checkQuota } from '../services/quota'

interface MockDbState {
  session?: Record<string, unknown> | null
  chunk?: Record<string, unknown> | null
  existingChunk?: Record<string, unknown> | null
  statements: Array<{ sql: string; bindings: unknown[] }>
}

const createStatement = (sql: string, state: MockDbState) => {
  const stmt = {
    bindings: [] as unknown[],
    bind: vi.fn((...args: unknown[]) => {
      stmt.bindings = args
      state.statements.push({ sql, bindings: args })
      return stmt
    }),
    first: vi.fn(async () => {
      if (sql.includes('FROM upload_sessions')) return state.session ?? null
      if (sql.includes('FROM blob_chunks') && sql.includes('hash = ?')) {
        if (sql.includes('SELECT id, r2_key')) return state.existingChunk ?? null
        if (sql.includes('r2_key') || sql.includes('size_bytes') || sql.includes('ref_count')) {
          return state.chunk ?? null
        }
      }
      return null
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
  }
  return stmt
}

const createDb = (state: MockDbState) =>
  ({
    prepare: vi.fn((sql: string) => createStatement(sql, state))
  }) as unknown as D1Database

const createR2Object = (overrides: Record<string, unknown> = {}) => ({
  size: 5,
  body: new ReadableStream(),
  range: { offset: 1, length: 3 },
  writeHttpMetadata: vi.fn(),
  text: vi.fn().mockResolvedValue(JSON.stringify({ chunks: ['a'] })),
  ...overrides
})

const storageObject = createR2Object()

const createStorage = () =>
  ({
    get: vi.fn().mockResolvedValue(storageObject),
    head: vi.fn().mockResolvedValue({ size: 5 }),
    put: vi.fn(),
    delete: vi.fn()
  }) as unknown as R2Bucket

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('', blob)
  return app
}

const createSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  user_id: 'user-1',
  attachment_id: 'att-1',
  filename: 'file.bin',
  total_size: 10,
  chunk_count: 2,
  uploaded_chunks: JSON.stringify([
    { i: 0, h: 'hash-0', b: 5 },
    { i: 1, h: 'hash-1', b: 5 }
  ]),
  expires_at: Math.floor(Date.now() / 1000) + 100,
  created_at: 1,
  ...overrides
})

const createEnv = (state: MockDbState) => ({
  DB: createDb(state),
  STORAGE: createStorage(),
  USER_SYNC_STATE: {} as DurableObjectNamespace,
  LINKING_SESSION: {} as DurableObjectNamespace,
  ENVIRONMENT: 'development',
  JWT_PUBLIC_KEY: 'pk',
  JWT_PRIVATE_KEY: 'sk',
  RESEND_API_KEY: 'resend',
  GOOGLE_CLIENT_ID: 'google-client',
  GOOGLE_CLIENT_SECRET: 'google-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost/callback',
  RECOVERY_DUMMY_SECRET: 'dummy'
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
    vi.mocked(checkQuota).mockResolvedValue(undefined)
    app = createApp()
    state = {
      session: createSession(),
      chunk: { id: 'chunk-1', r2_key: 'user-1/hash-0', size_bytes: 5, ref_count: 1 },
      existingChunk: null,
      statements: []
    }
    env = createEnv(state)
  })

  it('uploads a simple blob and records storage usage', async () => {
    const res = await app.request('/blob/blob-1', { method: 'PUT', body: 'hello' }, env)

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ blob_key: 'blob-1', size: 5, etag: 'etag-1' })
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 5)
    expect(checkQuota).toHaveBeenCalledWith(env.DB, 'user-1', 5)
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/items/blob-1',
      expect.any(ArrayBuffer),
      'user-1'
    )
  })

  it('downloads a simple blob with content length headers', async () => {
    vi.mocked(getBlob).mockResolvedValueOnce(createR2Object({ size: 7 }) as any)

    const res = await app.request('/blob/blob-1', { method: 'GET' }, env)

    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Length')).toBe('7')
    expect(getBlob).toHaveBeenCalledWith(env.STORAGE, 'user-1/items/blob-1', 'user-1')
  })

  it('downloads a byte range directly from R2', async () => {
    const res = await app.request(
      '/blob/blob-1',
      { method: 'GET', headers: { Range: 'bytes=1-3' } },
      env
    )

    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 1-3/5')
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/items/blob-1', {
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
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/items/blob-1', {
      range: { offset: 2 }
    })

    await app.request('/blob/blob-1', { method: 'GET', headers: { Range: 'bad-range' } }, env)
    expect(env.STORAGE.get).toHaveBeenCalledWith('user-1/items/blob-1', {
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
    expect(deleteBlob).toHaveBeenCalledWith(env.STORAGE, 'user-1/items/blob-1', 'user-1')
    expect(state.statements.some((entry) => entry.bindings[0] === -5)).toBe(true)
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
    expect(checkQuota).toHaveBeenCalledWith(env.DB, 'user-1', 10)
    expect(assertFileSizeAllowed).toHaveBeenCalledWith(env.DB, 'user-1', 10)
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
    state.existingChunk = null

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
      expect.stringMatching(/^user-1\/[a-f0-9]{64}$/),
      expect.any(ArrayBuffer),
      'user-1'
    )
  })

  it('rejects a chunk that would exceed the declared upload size', async () => {
    state.session = createSession({
      total_size: 10,
      uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 8 }])
    })

    const res = await app.request(
      '/attachments/upload/session-1/chunk/1',
      {
        method: 'PUT',
        body: 'abc'
      },
      env
    )

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.STORAGE_FILE_TOO_LARGE
    )
  })

  it('increments ref_count instead of storing an already-known chunk', async () => {
    state.session = createSession({ uploaded_chunks: '[]' })
    state.existingChunk = { id: 'existing-chunk', r2_key: 'user-1/hash' }

    const res = await app.request(
      '/attachments/upload/session-1/chunk/0',
      {
        method: 'PUT',
        body: 'chunk-data'
      },
      env
    )

    expect(res.status).toBe(200)
    expect(putBlob).not.toHaveBeenCalled()
    expect(state.statements.some((entry) => entry.sql.includes('ref_count = ref_count + 1'))).toBe(
      true
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

  it('rejects completion when uploaded chunk bytes do not match the declared total size', async () => {
    state.session = createSession({
      total_size: 10,
      uploaded_chunks: JSON.stringify([
        { i: 0, h: 'hash-0', b: 4 },
        { i: 1, h: 'hash-1', b: 4 }
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
      manifest_key: 'user-1/meta/att-1',
      size: 10
    })
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/meta/att-1',
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
    state.chunk = { id: 'chunk-1', ref_count: 1 }

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).toHaveBeenCalledWith(env.STORAGE, 'user-1/hash-0', 'user-1')
    expect(
      state.statements.some((entry) => entry.sql.includes('DELETE FROM upload_sessions'))
    ).toBe(true)
  })

  it('cancels an upload by decrementing shared chunks', async () => {
    state.chunk = { id: 'chunk-1', ref_count: 2 }

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(deleteBlob).not.toHaveBeenCalled()
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

  it('checks and downloads deduplicated chunks', async () => {
    let res = await app.request('/attachments/chunks/hash-0', { method: 'HEAD' }, env)
    expect(res.status).toBe(200)

    res = await app.request('/attachments/chunks/hash-0', { method: 'GET' }, env)
    expect(res.status).toBe(200)
    expect(getBlob).toHaveBeenCalledWith(env.STORAGE, 'user-1/hash-0', 'user-1')
  })

  it('returns 404 for missing chunk metadata or missing chunk data', async () => {
    state.chunk = null
    let res = await app.request('/attachments/chunks/missing', { method: 'HEAD' }, env)
    expect(res.status).toBe(404)

    res = await app.request('/attachments/chunks/missing', { method: 'GET' }, env)
    expect(res.status).toBe(404)

    state.chunk = { r2_key: 'user-1/hash-0' }
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
    expect(await res.json()).toEqual({ manifest_key: 'user-1/meta/att-1' })
    expect(putBlob).toHaveBeenCalledWith(
      env.STORAGE,
      'user-1/meta/att-1',
      expect.any(ArrayBuffer),
      'user-1'
    )
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
})
