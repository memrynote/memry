import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes } from '../lib/errors'
import { SYNC_PLAN_LIMITS, type SyncPlan } from '../services/entitlements'

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

import {
  createApp,
  createEnv,
  createSession,
  findBinding,
  type MockDbState
} from '../__mocks__/blob-route-harness'
import { adjustStorageUsed, reserveStorage } from '../services/quota'
import { CHUNK_CRYPTO_OVERHEAD, MAX_CHUNK_CRYPTO_OVERHEAD } from '../services/upload-size'

const MIB = 1024 * 1024

// A client-declared encrypted size that is plausible (inside the accepted band
// [totalSize, totalSize + MAX_CHUNK_CRYPTO_OVERHEAD * chunkCount]) but is NOT the
// value the server would derive. Tests using the derived overhead cannot tell the
// explicit branch from the derive path, because both produce the same number.
const DECLARED_OVERHEAD = 56

interface AccountingState extends MockDbState {
  plan: SyncPlan
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

describe('attachment upload size accounting (plaintext limit, encrypted storage)', () => {
  let app: ReturnType<typeof createApp>
  let state: AccountingState
  let env: any

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(reserveStorage).mockResolvedValue(undefined)
    vi.mocked(adjustStorageUsed).mockResolvedValue(undefined)
    app = createApp()
    state = { plan: 'pro', session: createSession(), statements: [] }
    state.entitlementRow = () => entitlementRow(state.plan)
    env = createEnv(state)
  })

  // The one place that holds the literal: a crypto-param change must land here.
  it('derives 40 bytes of per-chunk overhead from the crypto contract', () => {
    expect(CHUNK_CRYPTO_OVERHEAD).toBe(40)
    expect(DECLARED_OVERHEAD).toBeGreaterThan(CHUNK_CRYPTO_OVERHEAD)
    expect(DECLARED_OVERHEAD).toBeLessThanOrEqual(MAX_CHUNK_CRYPTO_OVERHEAD)
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
    // 1024 + 56 = 1080, where the server would derive 1024 + 40 = 1064. A chunk of
    // 1080 bytes only fits if the session's own encrypted_size wins.
    const declared = 1024 + DECLARED_OVERHEAD
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: declared })

    const res = await putChunk(app, env, 0, declared)

    expect(res.status).toBe(200)
  })

  it('rejects a chunk over an explicit encrypted_size that is below the derived value', async () => {
    // The explicit branch must also be able to make the budget SMALLER than the
    // derived one, not just larger.
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: 1024 })

    const res = await putChunk(app, env, 0, 1024 + CHUNK_CRYPTO_OVERHEAD)

    expect(res.status).toBe(413)
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

    // Asserted by position, not by membership: total_size and encrypted_size are
    // both numbers in the same bind list, so `toContain` cannot tell them apart —
    // swapping them would store ciphertext as plaintext and still pass.
    const insert = findBinding(state, 'INSERT INTO upload_sessions')
    expect(insert?.bindings).toEqual([
      expect.any(String), // id
      'user-1', // user_id
      'vault-1', // vault_id
      'att-1', // attachment_id
      'f.bin', // filename
      1024, // total_size stays plaintext
      1, // chunk_count
      1024 + CHUNK_CRYPTO_OVERHEAD, // encrypted_size persisted
      expect.any(Number), // expires_at
      expect.any(Number) // created_at
    ])
  })

  it('accepts an explicit encryptedSize from a new client', async () => {
    // Distinct from the derived 1024 + 40, so the assertion below can only hold if
    // the client's number is the one that reaches quota and storage.
    const declared = 1024 + DECLARED_OVERHEAD

    const res = await initiate(app, env, {
      attachmentId: 'att-1',
      filename: 'f.bin',
      totalSize: 1024,
      chunkCount: 1,
      encryptedSize: declared
    })

    expect(res.status).toBe(201)
    expect(reserveStorage).toHaveBeenCalledWith(env.DB, 'user-1', declared)

    const insert = findBinding(state, 'INSERT INTO upload_sessions')
    expect(insert?.bindings[5]).toBe(1024) // total_size stays plaintext
    expect(insert?.bindings[7]).toBe(declared) // encrypted_size is the client's value
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

  it('refunds the reserved encrypted_size when a session is cancelled', async () => {
    state.session = createSession({
      total_size: 1024,
      chunk_count: 1,
      encrypted_size: 1024 + CHUNK_CRYPTO_OVERHEAD
    })

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(adjustStorageUsed).toHaveBeenCalledWith(
      env.DB,
      'user-1',
      -(1024 + CHUNK_CRYPTO_OVERHEAD)
    )
  })

  // A session written by the OLD server reserved the PLAINTEXT total_size and left
  // encrypted_size NULL. Deriving the ciphertext total here refunds bytes that were
  // never reserved, permanently drifting users.storage_used down (adjustStorageUsed
  // clamps at 0, so the drift has no reconciliation path).
  it('refunds only the plaintext for a legacy session with no encrypted_size', async () => {
    state.session = createSession({ total_size: 1024, chunk_count: 1, encrypted_size: null })

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -1024)
  })

  it('refunds only the plaintext for a legacy multi-chunk session', async () => {
    state.session = createSession({ total_size: 500_000, chunk_count: 63, encrypted_size: null })

    const res = await app.request('/attachments/upload/session-1', { method: 'DELETE' }, env)

    expect(res.status).toBe(204)
    expect(adjustStorageUsed).toHaveBeenCalledWith(env.DB, 'user-1', -500_000)
  })
})
