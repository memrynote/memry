import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { errorHandler } from '../lib/errors'
import { signBootstrapSession, verifyBootstrapSession } from '../services/bootstrap-session'
import type { AppContext } from '../types'

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

vi.mock('../middleware/rate-limit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../middleware/rate-limit')>()
  return {
    ...actual,
    createRateLimiter: vi.fn().mockImplementation(() => async (_c: any, next: any) => {
      await next()
    })
  }
})

const { syncTypes } = vi.hoisted(() => ({ syncTypes: { value: ['note', 'task'] as string[] } }))

vi.mock('../middleware/sync-types', () => ({
  syncTypesMiddleware: vi.fn().mockImplementation(async (c: any, next: any) => {
    c.set('syncTypes', syncTypes.value)
    await next()
  })
}))

// Real manifest + chunk services over real SQLite. Presign availability is
// driven purely by env bindings (the real resolver), so the degradation path
// is exercised without any mock.

import { bootstrap } from './bootstrap'

const SECRET = 'test-bootstrap-hmac-key'
const R2_ENV = {
  R2_ACCESS_KEY_ID: 'test-r2-access-key-id',
  R2_SECRET_ACCESS_KEY: 'test-r2-secret-access-key',
  R2_S3_ENDPOINT: 'https://test-account.r2.cloudflarestorage.com',
  R2_S3_BUCKET: 'test-bucket'
}

let harness: SqliteD1

const createApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync/bootstrap', bootstrap)
  return app
}

const now = () => Math.floor(Date.now() / 1000)

beforeEach(() => {
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES ('user-1', 'boot@example.com', 1, 'otp', 0, 0, ?, ?)`
    )
    .run(now(), now())
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

const seedDevice = (opts: { deviceId?: string; lastCursor?: number | null } = {}): void => {
  const ts = now()
  const deviceId = opts.deviceId ?? 'device-1'
  harness.raw
    .prepare(
      `INSERT OR IGNORE INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, 'user-1', ?, 'desktop', '0.0.0-test', ?, 'vault-1', ?, ?)`
    )
    .run(deviceId, `dev-${deviceId}`, `pk-${deviceId}`, ts, ts)
  if (opts.lastCursor !== null) {
    harness.raw
      .prepare(
        `INSERT INTO device_sync_state (device_id, user_id, vault_id, last_cursor_seen, updated_at)
         VALUES (?, 'user-1', 'vault-1', ?, ?)`
      )
      .run(deviceId, opts.lastCursor ?? 42, ts)
  }
}

const seedItem = (itemId: string, cursor: number): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_items (
         id, user_id, vault_id, item_type, item_id, blob_key, size_bytes,
         content_hash, version, crypto_version, operation, signature,
         server_cursor, deleted_at, created_at, updated_at
       ) VALUES (?, 'user-1', 'vault-1', 'task', ?, ?, ?, ?, 1, 1, 'update', 'sig', ?, NULL, ?, ?)`
    )
    .run(`row-${itemId}`, itemId, `${itemId}-blob`, 64, `hash-${itemId}`, cursor, now(), now())
}

const seedChunk = (hash: string): void => {
  harness.raw
    .prepare(
      `INSERT INTO blob_chunks (id, hash, user_id, vault_id, r2_key, size_bytes, ref_count, created_at)
       VALUES (?, ?, 'user-1', 'vault-1', ?, 1024, 1, ?)`
    )
    .run(`chunk-${hash}`, hash, `user-1/vaults/vault-1/chunks/${hash}`, now())
}

describe('POST /sync/bootstrap', () => {
  it('answers 501 with a typed code when the deployment has no signing key', async () => {
    // #given — no BOOTSTRAP_SESSION_HMAC_KEY binding at all
    const app = createApp()
    const res = await app.request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development'
    } as never)

    // #then
    expect(res.status).toBe(501)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_UNAVAILABLE'
    )
  })

  it('refuses a device that already synced this vault with a typed 409', async () => {
    // #given
    seedDevice({ lastCursor: 42 })
    const app = createApp()

    // #when
    const res = await app.request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)

    // #then — the client's silent-fallback signal
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_NOT_ELIGIBLE'
    )
  })

  it('opens a session for a fresh device carrying manifest page + tail cursor + packs placeholder', async () => {
    // #given
    seedDevice({ lastCursor: null })
    for (let i = 1; i <= 3; i++) seedItem(`item-${i}`, i * 10)
    const app = createApp()

    // #when
    const res = await app.request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)
    const body = (await res.json()) as Record<string, any>

    // #then — first manifest page only, tail cursor is MAX(server_cursor),
    // packs reserved empty, and NO attachments key without presign config.
    expect(res.status).toBe(200)
    expect(body.manifest.items.map((i: { id: string }) => i.id)).toEqual([
      'item-1',
      'item-2',
      'item-3'
    ])
    expect('nextCursor' in body.manifest).toBe(false)
    expect(body.tailCursor).toBe(30)
    expect(body.packs).toEqual([])
    expect('attachments' in body).toBe(false)

    // The token verifies and binds to this exact device + vault.
    const verified = await verifyBootstrapSession(SECRET, body.session.token)
    expect(verified).toMatchObject({ userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1' })
    expect(body.session.expiresAt).toBe(verified?.expiresAt)
  })

  it('includes a bounded chunk-hash page when presign is configured', async () => {
    // #given — one past the page size, so the first page must report a cursor
    seedDevice({ lastCursor: null })
    const total = 513
    for (let i = 0; i < total; i++) {
      seedChunk(`h${String(i).padStart(63, '0')}`)
    }
    const app = createApp()

    // #when
    const res = await app.request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
      ...R2_ENV
    } as never)
    const body = (await res.json()) as Record<string, any>

    // #then — keyset page in hash order, cursor names the last hash served
    expect(body.attachments.chunkHashes).toHaveLength(512)
    expect(body.attachments.chunkHashes[0]).toBe(`h${'0'.repeat(63)}`)
    expect(body.attachments.nextChunkCursor).toBe(`h${String(511).padStart(63, '0')}`)
  })
})

describe('POST /sync/bootstrap/renew + /close', () => {
  const openSession = async (): Promise<Response> => {
    const app = createApp()
    return app.request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET,
      ...R2_ENV
    } as never)
  }

  const requestWithToken = async (
    path: string,
    token: string,
    deviceId?: string
  ): Promise<Response> => {
    const app = createApp()
    if (deviceId) {
      const { authMiddleware } = await import('../middleware/auth')
      vi.mocked(authMiddleware).mockImplementationOnce(async (c: any, next: any) => {
        c.set('userId', 'user-1')
        c.set('deviceId', deviceId)
        c.set('vaultId', 'vault-1')
        await next()
      })
    }
    return app.request(path, { method: 'POST', headers: { 'X-Memry-Bootstrap-Token': token } }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)
  }

  it('renews before expiry and extends the same ledger row', async () => {
    // #given
    seedDevice({ lastCursor: null })
    const openRes = await openSession()
    const opened = (await openRes.json()) as Record<string, any>

    // #when
    const renewRes = await requestWithToken('/sync/bootstrap/renew', opened.session.token)
    const renewed = (await renewRes.json()) as Record<string, any>

    // #then
    expect(renewRes.status).toBe(200)
    expect(renewed.session.expiresAt).toBeGreaterThanOrEqual(opened.session.expiresAt)
    const rows = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(rows.c).toBe(1)
    expect(await verifyBootstrapSession(SECRET, renewed.session.token)).toMatchObject({
      jti: (await verifyBootstrapSession(SECRET, opened.session.token))?.jti
    })
  })

  it('rejects renewal with a missing or forged token', async () => {
    // #given
    const app = createApp()

    // #when / #then
    const noToken = await app.request('/sync/bootstrap/renew', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)
    expect(noToken.status).toBe(401)

    const forged = await requestWithToken('/sync/bootstrap/renew', 'aaa.bbb')
    expect(forged.status).toBe(401)

    const { token } = await signBootstrapSession(
      'other-secret',
      { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', jti: 'j-forged' },
      now()
    )
    const wrongSecret = await requestWithToken('/sync/bootstrap/renew', token)
    expect(wrongSecret.status).toBe(401)
  })

  it('rejects renewal presented by another device — identity-bound (403)', async () => {
    // #given — device-1 holds a live session
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>

    // #when — device-2 replays the stolen-but-valid token
    const stolen = await requestWithToken('/sync/bootstrap/renew', opened.session.token, 'device-2')
    const body = (await stolen.json()) as { error: { code: string } }

    // #then — typed 403, ledger row untouched
    expect(stolen.status).toBe(403)
    expect(body.error.code).toBe('BOOTSTRAP_IDENTITY_MISMATCH')
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 1 }
    )
  })

  it('rejects close presented by another device', async () => {
    // #given
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>

    // #when / #then — mismatched close refused, session survives
    const stolenClose = await requestWithToken(
      '/sync/bootstrap/close',
      opened.session.token,
      'device-2'
    )
    expect(stolenClose.status).toBe(403)
    expect(((await stolenClose.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_IDENTITY_MISMATCH'
    )
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 1 }
    )

    // #and the owner's own close still succeeds
    const ownClose = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(ownClose.status).toBe(200)
  })

  it('answers a typed expiry once the absolute max lifetime is spent', async () => {
    // #given — a live-looking token whose ledger row was created MAX_LIFETIME ago
    seedDevice({ lastCursor: null })
    const past = now() - 6 * 60 * 60 - 10
    harness.raw
      .prepare(
        `INSERT INTO bootstrap_sessions (jti, user_id, device_id, vault_id, expires_at, created_at)
         VALUES ('j-max', 'user-1', 'device-1', 'vault-1', ?, ?)`
      )
      .bind(now() + 3600, past)
      .run()
    const { token } = await signBootstrapSession(
      SECRET,
      { userId: 'user-1', deviceId: 'device-1', vaultId: 'vault-1', jti: 'j-max' },
      now()
    )

    // #when
    const res = await requestWithToken('/sync/bootstrap/renew', token)
    const body = (await res.json()) as { error: { code: string } }

    // #then — 403 SESSION_EXPIRED (the client's normal close→fallback signal),
    // and the dead row is gone so it cannot pin a concurrency slot.
    expect(res.status).toBe(403)
    expect(body.error.code).toBe('BOOTSTRAP_SESSION_EXPIRED')
    expect(harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get()).toMatchObject(
      { c: 0 }
    )
  })

  it('closes idempotently and frees the concurrent-session slot', async () => {
    // #given — device A opens and closes; device B must then be able to open
    seedDevice({ lastCursor: null })
    const opened = (await (await openSession()).json()) as Record<string, any>
    const closeRes = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(closeRes.status).toBe(200)
    expect(((await closeRes.json()) as Record<string, unknown>).success).toBe(true)

    // #when — closing again is still 200
    const closeAgain = await requestWithToken('/sync/bootstrap/close', opened.session.token)
    expect(closeAgain.status).toBe(200)

    // #then — the slot is free
    const rows = harness.raw.prepare('SELECT COUNT(*) AS c FROM bootstrap_sessions').get() as {
      c: number
    }
    expect(rows.c).toBe(0)
  })

  it('enforces the per-user cap across devices at the route level', async () => {
    // #given — two fresh devices hold sessions
    seedDevice({ lastCursor: null })
    await openSession()
    seedDevice({ deviceId: 'device-2', lastCursor: null })
    const second = await createApp().request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)
    expect(second.status).toBe(200)

    // #when — a third fresh device tries
    seedDevice({ deviceId: 'device-3', lastCursor: null })
    const third = await createApp().request('/sync/bootstrap', { method: 'POST' }, {
      DB: harness.db,
      ENVIRONMENT: 'development',
      BOOTSTRAP_SESSION_HMAC_KEY: SECRET
    } as never)

    // #then
    expect(third.status).toBe(429)
    expect(((await third.json()) as { error: { code: string } }).error.code).toBe(
      'BOOTSTRAP_SESSION_LIMIT'
    )
  })
})
