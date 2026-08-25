import { describe, it, expect, vi, beforeEach } from 'vitest'

import { ErrorCodes } from '../lib/errors'
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

const { blobRateLimiterOptions, presignCalls } = vi.hoisted(() => ({
  blobRateLimiterOptions: [] as Array<{
    keyPrefix: string
    maxRequests: number
    windowSeconds: number
  }>,
  presignCalls: [] as Array<{ method: string; key: string }>
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

// Real signer, recorded inputs: URLs stay verifiable while tests can assert the
// method + exact R2 key that went into each signature.
vi.mock('../services/r2-presign', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/r2-presign')>()
  return {
    ...actual,
    presignR2Url: vi.fn(
      async (
        config: Parameters<typeof actual.presignR2Url>[0],
        options: Parameters<typeof actual.presignR2Url>[1]
      ) => {
        presignCalls.push({ method: options.method, key: options.key })
        return actual.presignR2Url(config, options)
      }
    )
  }
})

import {
  createApp,
  createEnv,
  createSession as baseSession,
  type MockDbState
} from '../__mocks__/blob-route-harness'
import { presignR2Url } from '../services/r2-presign'
import { CHUNK_CRYPTO_OVERHEAD } from '../services/upload-size'

// The hash charset is enforced by contract (64 lowercase hex); fixtures comply.
const HASH_A = 'a'.repeat(64)
const HASH_B = 'b'.repeat(64)

const R2_ENV = {
  // `test-` prefixed so the staged-secret scanner reads these as placeholders.
  R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
  R2_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  R2_S3_BUCKET: 'test-bucket'
}

describe('presigned direct transfers (#1836)', () => {
  let app: ReturnType<typeof createApp>
  let state: MockDbState
  let env: ReturnType<typeof createEnv>

  const hexHash = (ch: string): string => ch.repeat(64)

  beforeEach(() => {
    vi.clearAllMocks()
    // blobRateLimiterOptions is captured once at route-module import and is
    // asserted below without resetting — only call records are per-test.
    presignCalls.length = 0
    app = createApp()
    state = { session: null, statements: [] }
    env = { ...createEnv(state), ...R2_ENV }
  })

  const seedChunkRows = (): void => {
    state.chunksByHash = {
      [HASH_A]: {
        id: 'chunk-a',
        hash: HASH_A,
        user_id: 'user-1',
        vault_id: 'vault-1',
        r2_key: 'user-1/vaults/vault-1/chunks/' + HASH_A,
        size_bytes: 45,
        ref_count: 1
      },
      [HASH_B]: {
        id: 'chunk-b',
        hash: HASH_B,
        user_id: 'user-1',
        vault_id: 'vault-1',
        r2_key: 'user-1/vaults/vault-1/chunks/' + HASH_B,
        size_bytes: 45,
        ref_count: 1
      }
    }
  }

  describe('POST /attachments/presign-batch', () => {
    it('registers its own additive rate bucket at 120/min', () => {
      // Importing the route module populates the captured options; the bucket
      // must exist with its own prefix so presign traffic cannot crowd out the
      // proxied chunk buckets.
      expect(blobRateLimiterOptions.map((o) => o.keyPrefix)).toContain('blob_presign')
      const bucket = blobRateLimiterOptions.find((o) => o.keyPrefix === 'blob_presign')!
      expect(bucket.maxRequests).toBe(120)
      expect(bucket.windowSeconds).toBe(60)
    })

    it('answers 501 STORAGE_PRESIGN_UNAVAILABLE when secrets are absent — graceful degradation signal', async () => {
      env = createEnv(state)
      const res = await app.request(
        '/attachments/presign-batch',
        { method: 'POST', body: JSON.stringify({ chunkHashes: [HASH_A] }) },
        env
      )
      expect(res.status).toBe(501)
      expect(await res.json()).toMatchObject({
        error: { code: ErrorCodes.STORAGE_PRESIGN_UNAVAILABLE }
      })
    })

    it('issues one GET URL per owned chunk, keyed by hash, minutes-scale expiry', async () => {
      seedChunkRows()
      const res = await app.request(
        '/attachments/presign-batch',
        { method: 'POST', body: JSON.stringify({ chunkHashes: [HASH_A, HASH_B] }) },
        env
      )
      expect(res.status).toBe(200)
      const body = (await res.json()) as { urls: Record<string, string>; expiresAt: number }

      expect(Object.keys(body.urls).sort()).toEqual([HASH_A, HASH_B].sort())
      for (const url of Object.values(body.urls)) {
        expect(url).toContain('https://test-account.r2.cloudflarestorage.com/test-bucket/')
        expect(url).toContain('X-Amz-Signature=')
      }
      expect(body.urls[HASH_A]).toContain(`chunks/${HASH_A}`)

      expect(presignCalls).toHaveLength(2)
      expect(presignCalls.every((call) => call.method === 'GET')).toBe(true)
      // Keys come from D1 rows scoped by user+vault — never client-supplied.
      expect(presignCalls.map((c) => c.key)).toEqual([
        `user-1/vaults/vault-1/chunks/${HASH_A}`,
        `user-1/vaults/vault-1/chunks/${HASH_B}`
      ])

      expect(body.expiresAt).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000) + 295)
      expect(body.expiresAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000) + 300)
    })

    it('rejects a hash owned by another user/vault with 404 — SQL scoping, not just absence', async () => {
      // HASH_B EXISTS in the fixture table, but under user-9/vault-9. The
      // presign-batch query's `user_id = ? AND vault_id = ?` predicates must
      // make it read as absent for this caller; if those predicates ever
      // regress, this row comes back and gets signed — this test goes red on
      // exactly that mutation (verified by dropping the predicates).
      state.chunksByHash = {
        [HASH_A]: {
          id: 'chunk-a',
          hash: HASH_A,
          user_id: 'user-1',
          vault_id: 'vault-1',
          r2_key: 'user-1/vaults/vault-1/chunks/' + HASH_A,
          size_bytes: 45,
          ref_count: 1
        },
        [HASH_B]: {
          id: 'chunk-b',
          hash: HASH_B,
          user_id: 'user-9',
          vault_id: 'vault-9',
          r2_key: 'user-9/vaults/vault-9/chunks/' + HASH_B,
          size_bytes: 45,
          ref_count: 1
        }
      }
      const res = await app.request(
        '/attachments/presign-batch',
        { method: 'POST', body: JSON.stringify({ chunkHashes: [HASH_A, HASH_B] }) },
        env
      )
      expect(res.status).toBe(404)
      expect(await res.json()).toMatchObject({
        error: { code: ErrorCodes.STORAGE_BLOB_NOT_FOUND }
      })
      expect(presignCalls).toHaveLength(0)
    })

    it('rejects unknown hashes even when other chunks in the batch resolve', async () => {
      seedChunkRows()
      const res = await app.request(
        '/attachments/presign-batch',
        { method: 'POST', body: JSON.stringify({ chunkHashes: [HASH_A, hexHash('c')] }) },
        env
      )
      expect(res.status).toBe(404)
      expect(presignCalls).toHaveLength(0)
    })

    it.each([
      ['non-hex hash', { chunkHashes: ['../etc/passwd'] }],
      ['empty batch', { chunkHashes: [] }],
      ['missing field', {}]
    ])('rejects invalid bodies (%s) with 400', async (_name, payload) => {
      const res = await app.request(
        '/attachments/presign-batch',
        { method: 'POST', body: JSON.stringify(payload) },
        env
      )
      expect(res.status).toBe(400)
      expect(presignCalls).toHaveLength(0)
    })
  })

  describe('upload initiate opt-in', () => {
    const initBody = (extra: Record<string, unknown> = {}) => ({
      attachmentId: 'att-1',
      filename: 'file.bin',
      totalSize: 10,
      chunkCount: 2,
      encryptedSize: 10 + CHUNK_CRYPTO_OVERHEAD * 2,
      ...extra
    })

    it('returns presigned PUT URLs per chunk hash when opted in', async () => {
      const res = await app.request(
        '/attachments/upload/initiate',
        { method: 'POST', body: JSON.stringify(initBody({ chunkHashes: [HASH_A, HASH_B] })) },
        env
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as {
        sessionId: string
        chunkUrls?: Record<string, string>
        urlExpiresAt?: number
      }
      expect(body.chunkUrls?.[HASH_A]).toContain(`chunks/${HASH_A}`)
      expect(body.chunkUrls?.[HASH_B]).toContain(`chunks/${HASH_B}`)
      expect(presignCalls.every((c) => c.method === 'PUT')).toBe(true)
      expect(body.urlExpiresAt).toBeGreaterThan(Date.now() / 1000)
    })

    it('stays byte-compatible without chunkHashes: no chunkUrls key at all', async () => {
      const res = await app.request(
        '/attachments/upload/initiate',
        { method: 'POST', body: JSON.stringify(initBody()) },
        env
      )
      expect(res.status).toBe(201)
      const raw = (await res.text()) as string
      expect(JSON.parse(raw)).toEqual({
        sessionId: expect.any(String),
        expiresAt: expect.any(Number)
      })
      expect(raw).not.toContain('chunkUrls')
      expect(presignCalls).toHaveLength(0)
    })

    it('degrades gracefully when credentials are absent: session still opens, no URLs', async () => {
      env = createEnv(state)
      const res = await app.request(
        '/attachments/upload/initiate',
        { method: 'POST', body: JSON.stringify(initBody({ chunkHashes: [HASH_A, HASH_B] })) },
        env
      )
      expect(res.status).toBe(201)
      const body = (await res.json()) as { sessionId: string; chunkUrls?: unknown }
      expect(body.sessionId).toBeTruthy()
      expect(body.chunkUrls).toBeUndefined()
    })

    it('rejects chunkHashes whose length does not match chunkCount', async () => {
      const res = await app.request(
        '/attachments/upload/initiate',
        { method: 'POST', body: JSON.stringify(initBody({ chunkHashes: [HASH_A] })) },
        env
      )
      expect(res.status).toBe(400)
    })

    it('rejects duplicate hashes', async () => {
      const res = await app.request(
        '/attachments/upload/initiate',
        { method: 'POST', body: JSON.stringify(initBody({ chunkHashes: [HASH_A, HASH_A] })) },
        env
      )
      expect(res.status).toBe(400)
    })
  })

  describe('complete-time reconciliation of direct chunks', () => {
    // One proxied chunk already registered ({i:0}), one claimed direct ({i:1}).
    const DIRECT_HASH = hexHash('d')
    const PROXIED_HASH = hexHash('p')

    beforeEach(() => {
      state.session = baseSession({
        total_size: 10,
        chunk_count: 2,
        encrypted_size: 10 + CHUNK_CRYPTO_OVERHEAD * 2,
        uploaded_chunks: JSON.stringify([{ i: 0, h: PROXIED_HASH, b: 5 + CHUNK_CRYPTO_OVERHEAD }])
      })
    })

    const completeBody = (
      directChunks: unknown[] | undefined,
      extra: Record<string, unknown> = {}
    ) =>
      JSON.stringify({
        encryptedManifest: 'enc',
        manifestNonce: 'n',
        encryptedFileKey: 'k',
        keyNonce: 'kn',
        manifestSignature: 'sig',
        signerDeviceId: 'device-1',
        ...(directChunks === undefined ? {} : { directChunks }),
        ...extra
      })

    const headByKey = (sizes: Record<string, number | null>): void => {
      vi.mocked(env.STORAGE.head).mockImplementation((async (key: string) => {
        for (const [fragment, size] of Object.entries(sizes)) {
          if (key.includes(fragment)) {
            return (size === null ? null : { size }) as unknown as R2Object
          }
        }
        return null
      }) as unknown as (key: string) => Promise<R2Object | null>)
    }

    it('head-verifies claims, registers blob_chunks rows and merges session state', async () => {
      headByKey({ [DIRECT_HASH]: 5 + CHUNK_CRYPTO_OVERHEAD })
      const res = await app.request(
        '/attachments/upload/session-1/complete',
        {
          method: 'POST',
          body: completeBody([{ i: 1, h: DIRECT_HASH, b: 5 + CHUNK_CRYPTO_OVERHEAD }])
        },
        env
      )
      expect(res.status).toBe(200)

      const upsert = state.statements.find((s) => s.sql.includes('INSERT INTO blob_chunks'))
      expect(upsert?.bindings).toEqual([
        expect.any(String),
        DIRECT_HASH,
        'user-1',
        'vault-1',
        `user-1/vaults/vault-1/chunks/${DIRECT_HASH}`,
        5 + CHUNK_CRYPTO_OVERHEAD,
        expect.any(Number)
      ])
      expect(state.statements.some((s) => s.sql.includes('json_insert'))).toBe(true)
    })

    it('rejects a claim whose object is missing from R2 — quota only credits existing bytes', async () => {
      headByKey({ [DIRECT_HASH]: null })
      const res = await app.request(
        '/attachments/upload/session-1/complete',
        { method: 'POST', body: completeBody([{ i: 1, h: DIRECT_HASH, b: 45 }]) },
        env
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: ErrorCodes.UPLOAD_INCOMPLETE } })
    })

    it('rejects a claim whose stored size differs from the reported byte count', async () => {
      headByKey({ [DIRECT_HASH]: 999 })
      const res = await app.request(
        '/attachments/upload/session-1/complete',
        { method: 'POST', body: completeBody([{ i: 1, h: DIRECT_HASH, b: 45 }]) },
        env
      )
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: ErrorCodes.UPLOAD_INCOMPLETE } })
    })

    it('ignores stale direct claims for indices the proxied path already registered', async () => {
      // Fully proxied session; the client still reports both as direct claims
      // (e.g. it retried everything through the proxy after a network blip).
      state.session = baseSession({
        total_size: 10,
        chunk_count: 2,
        encrypted_size: 10 + CHUNK_CRYPTO_OVERHEAD * 2,
        uploaded_chunks: JSON.stringify([
          { i: 0, h: hexHash('e'), b: 5 + CHUNK_CRYPTO_OVERHEAD },
          { i: 1, h: hexHash('f'), b: 5 + CHUNK_CRYPTO_OVERHEAD }
        ])
      })
      headByKey({})
      const res = await app.request(
        '/attachments/upload/session-1/complete',
        {
          method: 'POST',
          body: completeBody([
            { i: 0, h: hexHash('e'), b: 5 + CHUNK_CRYPTO_OVERHEAD },
            { i: 1, h: hexHash('f'), b: 5 + CHUNK_CRYPTO_OVERHEAD }
          ])
        },
        env
      )
      // Every claimed index already landed via the proxy: nothing to verify or
      // write — and no double ref_count increments.
      expect(res.status).toBe(200)
      expect(state.statements.some((s) => s.sql.includes('INSERT INTO blob_chunks'))).toBe(false)
      // The only head is the manifest-existence check from the legacy flow.
      expect(vi.mocked(env.STORAGE.head)).toHaveBeenCalledTimes(1)
    })

    it('rejects duplicate indices and out-of-range indices in the report', async () => {
      headByKey({ [DIRECT_HASH]: 45 })
      for (const report of [
        [
          { i: 1, h: DIRECT_HASH, b: 45 },
          { i: 1, h: HASH_A, b: 45 }
        ],
        [{ i: 7, h: DIRECT_HASH, b: 45 }]
      ]) {
        const res = await app.request(
          '/attachments/upload/session-1/complete',
          { method: 'POST', body: completeBody(report) },
          env
        )
        expect(res.status).toBe(400)
      }
    })

    it('keeps the legacy path untouched when no directChunks are reported', async () => {
      // A fully proxied session: every chunk was registered by its own PUT.
      state.session = baseSession({
        total_size: 10,
        chunk_count: 2,
        encrypted_size: 10 + CHUNK_CRYPTO_OVERHEAD * 2,
        uploaded_chunks: JSON.stringify([
          { i: 0, h: hexHash('e'), b: 5 + CHUNK_CRYPTO_OVERHEAD },
          { i: 1, h: hexHash('f'), b: 5 + CHUNK_CRYPTO_OVERHEAD }
        ])
      })
      headByKey({})
      const res = await app.request(
        '/attachments/upload/session-1/complete',
        { method: 'POST', body: completeBody(undefined) },
        env
      )
      expect(res.status).toBe(200)
      expect(state.statements.some((s) => s.sql.includes('INSERT INTO blob_chunks'))).toBe(false)
    })
  })

  it('signs through the real SigV4 chain (sanity: signature present and stable-shaped)', async () => {
    seedChunkRows()
    const res = await app.request(
      '/attachments/presign-batch',
      { method: 'POST', body: JSON.stringify({ chunkHashes: [HASH_A] }) },
      env
    )
    const body = (await res.json()) as { urls: Record<string, string> }
    const url = new URL(body.urls[HASH_A])
    expect(url.searchParams.get('X-Amz-Algorithm')).toBe('AWS4-HMAC-SHA256')
    expect(url.searchParams.get('X-Amz-Credential')).toContain('test-r2-access-key-id')
    // Minutes-scale TTL is policy-enforced regardless of caller input.
    expect(Number(url.searchParams.get('X-Amz-Expires'))).toBeLessThanOrEqual(300)
    // The exported signer is exercised directly by r2-presign.test.ts against
    // AWS's published vector; this guards the route→signer wiring only.
    expect(typeof presignR2Url).toBe('function')
  })
})
