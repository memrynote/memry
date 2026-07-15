import { Hono } from 'hono'
import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes, errorHandler } from '../lib/errors'
import { SYNC_PLAN_LIMITS, type SyncPlan } from '../services/entitlements'
import { XCHACHA20_PARAMS } from '@memry/contracts/crypto'
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
  deleteBlob: vi.fn().mockResolvedValue(undefined)
}))

vi.mock('../services/quota', () => ({
  adjustStorageUsed: vi.fn().mockResolvedValue(undefined),
  checkQuota: vi.fn().mockResolvedValue(undefined),
  reserveStorage: vi.fn().mockResolvedValue(undefined)
}))

// NOTE: ../services/entitlements is deliberately NOT mocked. These tests drive the
// real plan limits so that "5 MiB on plus" means the real 5 MiB constant.

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
import { adjustStorageUsed, reserveStorage } from '../services/quota'

// The client encrypts every chunk as nonce(24) || XChaCha20-Poly1305 ciphertext
// (plaintext + 16-byte tag). See apps/desktop/src/main/sync/attachments.ts.
const CHUNK_CRYPTO_OVERHEAD = XCHACHA20_PARAMS.NONCE_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH
const MIB = 1024 * 1024

interface MockDbState {
  plan: SyncPlan
  session?: Record<string, unknown> | null
  existingChunk?: Record<string, unknown> | null
  statements: Array<{ sql: string; bindings: unknown[] }>
}

const entitlementRow = (plan: SyncPlan) => {
  const limits = SYNC_PLAN_LIMITS[plan]
  return {
    user_id: 'user-1',
    storage_used: 0,
    plan,
    status: plan === 'free' ? 'inactive' : 'active',
    source: plan === 'free' ? 'none' : 'paddle',
    storage_limit: limits.storageLimit,
    max_file_size: limits.maxFileSize,
    max_vaults: limits.maxVaults,
    version_history_days: limits.versionHistoryDays,
    paddle_customer_id: null,
    paddle_subscription_id: null,
    paddle_transaction_id: null,
    expires_at: null
  }
}

const createStatement = (sql: string, state: MockDbState) => {
  const stmt = {
    bind: vi.fn((...args: unknown[]) => {
      state.statements.push({ sql, bindings: args })
      return stmt
    }),
    first: vi.fn(async () => {
      if (sql.includes('FROM users u')) return entitlementRow(state.plan)
      if (sql.includes('FROM upload_sessions')) return state.session ?? null
      if (sql.includes('FROM blob_chunks')) return state.existingChunk ?? null
      return null
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } })
  }
  return stmt
}

const createEnv = (state: MockDbState) =>
  ({
    DB: { prepare: vi.fn((sql: string) => createStatement(sql, state)) } as unknown as D1Database,
    STORAGE: {
      get: vi.fn().mockResolvedValue(null),
      head: vi.fn().mockResolvedValue(null),
      put: vi.fn(),
      delete: vi.fn()
    } as unknown as R2Bucket,
    ENVIRONMENT: 'development'
  }) as any

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('', blob)
  return app
}

/** A session row as the server would have written it, with encrypted_size support. */
const createSession = (overrides: Record<string, unknown> = {}) => ({
  id: 'session-1',
  user_id: 'user-1',
  vault_id: 'vault-1',
  attachment_id: 'att-1',
  filename: 'file.bin',
  total_size: 1024,
  chunk_count: 1,
  encrypted_size: null,
  uploaded_chunks: '[]',
  expires_at: Math.floor(Date.now() / 1000) + 100,
  created_at: 1,
  ...overrides
})

const initiate = (app: ReturnType<typeof createApp>, env: any, body: Record<string, unknown>) =>
  app.request(
    '/attachments/upload/initiate',
    { method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } },
    env
  )

const putChunk = (app: ReturnType<typeof createApp>, env: any, index: number, bytes: number) =>
  app.request(
    `/attachments/upload/session-1/chunk/${index}`,
    { method: 'PUT', body: new Uint8Array(bytes) },
    env
  )

const findBinding = (state: MockDbState, sqlFragment: string) =>
  state.statements.find((s) => s.sql.includes(sqlFragment))

describe('attachment upload size accounting (plaintext limit, encrypted storage)', () => {
  let app: ReturnType<typeof createApp>
  let state: MockDbState
  let env: any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reserveStorage).mockResolvedValue(undefined)
    vi.mocked(adjustStorageUsed).mockResolvedValue(undefined)
    app = createApp()
    state = { plan: 'pro', session: createSession(), existingChunk: null, statements: [] }
    env = createEnv(state)
  })

  it('derives 40 bytes of per-chunk overhead from the crypto contract', () => {
    expect(XCHACHA20_PARAMS.NONCE_LENGTH + XCHACHA20_PARAMS.TAG_LENGTH).toBe(40)
    expect(CHUNK_CRYPTO_OVERHEAD).toBe(40)
  })

  // ==========================================================================
  // The 58-day regression: a single-chunk upload of N plaintext bytes puts
  // N + 40 bytes on the wire and must be accepted.
  // ==========================================================================

  it('accepts a single chunk of plaintext+40 bytes against a declared plaintext size', async () => {
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: null })

    const res = await putChunk(app, env, 0, 1024 + CHUNK_CRYPTO_OVERHEAD)

    expect(res.status).toBe(200)
  })

  it('accepts a 2-chunk upload totalling plaintext+80 bytes', async () => {
    state.session = createSession({
      total_size: 2048,
      chunk_count: 2,
      encrypted_size: null,
      uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 1024 + CHUNK_CRYPTO_OVERHEAD }])
    })

    const res = await putChunk(app, env, 1, 1024 + CHUNK_CRYPTO_OVERHEAD)

    expect(res.status).toBe(200)
  })

  it('still rejects a chunk that exceeds the derived encrypted total', async () => {
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: null })

    const res = await putChunk(app, env, 0, 1024 + CHUNK_CRYPTO_OVERHEAD + 1)

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.STORAGE_FILE_TOO_LARGE
    )
  })

  it('honours an explicit encrypted_size on the session over the derived value', async () => {
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: 1064 })

    const res = await putChunk(app, env, 0, 1064)

    expect(res.status).toBe(200)
  })

  // ==========================================================================
  // initiate: plan limit on plaintext, storage reservation on ciphertext
  // ==========================================================================

  it('derives the encrypted size for an old client that sends no encryptedSize', async () => {
    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1
    })

    expect(res.status).toBe(201)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', 1024 + CHUNK_CRYPTO_OVERHEAD)

    const insert = findBinding(state, 'INSERT INTO upload_sessions')
    expect(insert?.bindings).toContain(1024) // total_size stays plaintext
    expect(insert?.bindings).toContain(1024 + CHUNK_CRYPTO_OVERHEAD) // encrypted_size persisted
  })

  it('accepts an explicit encryptedSize from a new client', async () => {
    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1,
      encryptedSize: 1024 + CHUNK_CRYPTO_OVERHEAD
    })

    expect(res.status).toBe(201)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', 1024 + CHUNK_CRYPTO_OVERHEAD)
  })

  it('reserves plaintext+80 for a 2-chunk upload', async () => {
    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 2048,
      chunkCount: 2
    })

    expect(res.status).toBe(201)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', 2048 + CHUNK_CRYPTO_OVERHEAD * 2)
  })

  it('lets a plus user upload a file of exactly the 5 MiB plaintext limit', async () => {
    state.plan = 'plus'
    expect(SYNC_PLAN_LIMITS.plus.maxFileSize).toBe(5 * MIB)

    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 5 * MIB,
      chunkCount: 1
    })

    expect(res.status).toBe(201)
    // encryption overhead is charged to storage, never to the plan file-size limit
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', 5 * MIB + CHUNK_CRYPTO_OVERHEAD)
  })

  it('rejects a plus user one byte over the 5 MiB plaintext limit', async () => {
    state.plan = 'plus'

    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 5 * MIB + 1,
      chunkCount: 1
    })

    expect(res.status).toBe(413)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.STORAGE_FILE_TOO_LARGE
    )
    expect(reserveStorage).not.toHaveBeenCalled()
  })

  it('rejects a free user with 402', async () => {
    state.plan = 'free'

    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1
    })

    expect(res.status).toBe(402)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.SYNC_PAYMENT_REQUIRED
    )
    expect(reserveStorage).not.toHaveBeenCalled()
  })

  it('rejects an implausible client encryptedSize without inflating quota', async () => {
    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1,
      encryptedSize: 10240
    })

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.VALIDATION_ERROR
    )
    expect(reserveStorage).not.toHaveBeenCalled()
  })

  it('rejects a client encryptedSize below the plaintext size', async () => {
    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1,
      encryptedSize: 512
    })

    expect(res.status).toBe(400)
    expect(reserveStorage).not.toHaveBeenCalled()
  })

  // ==========================================================================
  // complete
  // ==========================================================================

  it('completes when uploaded bytes match the derived encrypted total', async () => {
    state.session = createSession({
      total_size: 1024,
      chunk_count: 1,
      encrypted_size: null,
      uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 1024 + CHUNK_CRYPTO_OVERHEAD }])
    })

    const res = await app.request(
      '/attachments/upload/session-1/complete',
      { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } },
      env
    )

    expect(res.status).toBe(200)
    expect(((await res.json()) as { size: number }).size).toBe(1024)
  })

  it('rejects complete when uploaded bytes are only the plaintext total', async () => {
    state.session = createSession({
      total_size: 1024,
      chunk_count: 1,
      encrypted_size: null,
      uploaded_chunks: JSON.stringify([{ i: 0, h: 'hash-0', b: 1024 }])
    })

    const res = await app.request(
      '/attachments/upload/session-1/complete',
      { method: 'POST', body: JSON.stringify({}), headers: { 'Content-Type': 'application/json' } },
      env
    )

    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      ErrorCodes.UPLOAD_INCOMPLETE
    )
  })

  // ==========================================================================
  // refunds
  // ==========================================================================

  it('refunds the encrypted total when a session is cancelled', async () => {
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: null })

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(adjustStorageUsed).toHaveBeenCalledWith(
      env.DB,
      'user-1',
      -(1024 + CHUNK_CRYPTO_OVERHEAD)
    )
  })
})
