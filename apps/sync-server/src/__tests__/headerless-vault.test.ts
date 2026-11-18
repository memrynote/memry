import { Hono } from 'hono'
import { SignJWT, exportSPKI, generateKeyPair } from 'jose'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { errorHandler } from '../lib/errors'
import { blob } from '../routes/blob'
import { sync } from '../routes/sync'
import type { AppContext } from '../types'

/**
 * A request with no X-Memry-Vault-Id never creates a vault.
 *
 * iOS registers its device with no vault id, which the server stores as
 * 'default', and reads storage with no vault header. Auth used to hand the
 * device row's vault id to the paid-sync middleware, which UPSERTS the
 * request's vault: the read minted a phantom 'default' vault, or on a
 * one-vault plan answered 402 vault-limit. The middleware tests passed because
 * their hand-built context carried no device vault, so this suite runs the
 * real auth and paid-sync middleware over real SQLite with a signed token.
 */

const USER_ID = 'user-headerless'
const DEVICE_ID = 'device-ios'
const REAL_VAULT = 'vault-real'

let harness: SqliteD1
let token: string
let publicKeyPem: string

const app = new Hono<AppContext>()
app.onError(errorHandler)
app.route('/sync', sync)
app.route('/sync', blob)

const rateLimiter = {
  idFromName: (name: string) => name,
  get: () => ({
    fetch: async () => Response.json({ count: 1, windowStart: Math.floor(Date.now() / 1000) })
  })
}

const request = (
  path: string,
  init: { method?: string; headers?: Record<string, string>; body?: string } = {}
) =>
  app.request(
    path,
    { method: 'GET', ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } },
    {
      DB: harness.db,
      JWT_PUBLIC_KEY: publicKeyPem,
      RATE_LIMITER: rateLimiter,
      // An empty bucket: no vault-scoped read finds anything to serve.
      STORAGE: { get: async () => null },
      ENVIRONMENT: 'test'
    },
    { waitUntil: () => {}, passThroughOnException: () => {}, props: {} }
  )

const vaultIds = (): string[] =>
  (
    harness.raw
      .prepare('SELECT vault_id FROM sync_vaults WHERE user_id = ? ORDER BY vault_id')
      .all(USER_ID) as { vault_id: string }[]
  ).map((row) => row.vault_id)

const grant = (plan: string, maxVaults: number | null): void => {
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, ?, 'active', 'paddle', ?, ?, ?, 30, 1)`
    )
    .run(USER_ID, plan, 10 * 1024 * 1024 * 1024, 100 * 1024 * 1024, maxVaults)
}

beforeEach(async () => {
  harness = createSqliteD1()
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, 1, 1)`
    )
    .run(USER_ID, `${USER_ID}@example.com`)
  // Registered with no vault id, as iOS does.
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, vault_id, created_at, updated_at)
       VALUES (?, ?, 'iPhone', 'ios', '1.0.0', 'key', 'default', 1, 1)`
    )
    .run(DEVICE_ID, USER_ID)
  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES ('row-1', ?, ?, 1, 1)`
    )
    .run(USER_ID, REAL_VAULT)

  const { privateKey, publicKey } = await generateKeyPair('EdDSA', { crv: 'Ed25519' })
  publicKeyPem = await exportSPKI(publicKey)
  token = await new SignJWT({ type: 'access', device_id: DEVICE_ID })
    .setProtectedHeader({ alg: 'EdDSA' })
    .setSubject(USER_ID)
    .setIssuedAt()
    .setIssuer('memry-sync')
    .setAudience('memry-client')
    .setExpirationTime('1h')
    .sign(privateKey)
})

afterEach(() => {
  harness.close()
})

describe.each([
  { plan: 'plus', maxVaults: 1 },
  { plan: 'believer', maxVaults: null }
])('a header-less request on $plan', ({ plan, maxVaults }) => {
  beforeEach(() => grant(plan, maxVaults))

  it('reads storage without creating a vault', async () => {
    const res = await request('/sync/storage')

    expect(res.status).toBe(200)
    expect(vaultIds()).toEqual([REAL_VAULT])
  })

  it('syncs against the account’s only vault, not the device’s registered one', async () => {
    const res = await request('/sync/status')

    expect(res.status).toBe(200)
    expect(vaultIds()).toEqual([REAL_VAULT])
  })
})

it('refuses storage to an account without a plan, creating nothing', async () => {
  const res = await request('/sync/storage')

  expect(res.status).toBe(402)
  const body = (await res.json()) as { error: { code: string } }
  expect(body.error.code).toBe('SYNC_PAYMENT_REQUIRED')
  expect(vaultIds()).toEqual([REAL_VAULT])
})

// #3967: memry-core polls GET /sync/status with no X-Memry-Vault-Id at the start
// of a pass, racing vault registration. On an account with no vaults yet the
// poll minted `default`, and on Plus the real vault's registration then hit 402.
describe.each([
  { plan: 'plus', maxVaults: 1 },
  { plan: 'believer', maxVaults: null }
])('a header-less status poll on a $plan account with no vaults', ({ plan, maxVaults }) => {
  beforeEach(() => {
    harness.raw.prepare('DELETE FROM sync_vaults WHERE user_id = ?').run(USER_ID)
    grant(plan, maxVaults)
  })

  it('answers as before and creates no vault, so registration yields exactly that vault', async () => {
    const status = await request('/sync/status')

    expect(status.status).toBe(200)
    expect(await status.json()).toEqual({
      connected: true,
      pendingItems: 0,
      serverTime: expect.any(Number)
    })
    expect(vaultIds()).toEqual([])

    const registered = await request('/sync/vaults', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ vaultUuid: REAL_VAULT, encryptedName: 'name', nameNonce: 'nonce' })
    })

    expect(registered.status).toBe(200)
    expect(vaultIds()).toEqual([REAL_VAULT])
  })
})

// #4816 review: the read middleware keeps every vault answer the upserting one
// gives, it only skips the insert.
describe('the status read on an account that already holds vaults', () => {
  const addVault = (vaultId: string): void => {
    harness.raw
      .prepare(
        `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, 1, 1)`
      )
      .run(`row-${vaultId}`, USER_ID, vaultId)
  }

  it('serves a legacy `default` vault next to another one, creating nothing', async () => {
    grant('believer', null)
    addVault('default')

    const res = await request('/sync/status')

    expect(res.status).toBe(200)
    expect(vaultIds()).toEqual(['default', REAL_VAULT])
  })

  it('refuses a header-less read when two vaults could answer, creating nothing', async () => {
    grant('believer', null)
    addVault('vault-other')

    const res = await request('/sync/status')

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('VALIDATION_ERROR')
    expect(vaultIds()).toEqual(['vault-other', REAL_VAULT])
  })

  it('refuses a second vault on Plus with 402, creating nothing', async () => {
    grant('plus', 1)

    const res = await request('/sync/status', { headers: { 'X-Memry-Vault-Id': 'vault-new' } })

    expect(res.status).toBe(402)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('SYNC_VAULT_LIMIT_EXCEEDED')
    expect(vaultIds()).toEqual([REAL_VAULT])
  })
})

// #4278: the status fix (#3967) covered one route. Every other vault-scoped
// read still upserted the vault it resolved, so a header-less manifest, changes
// or pull on an empty account minted `default`, and on Plus the real vault's
// registration then got a 402 no upgrade could clear. Reads now resolve and
// check the vault without inserting it, and answer from an empty vault.
const json = (body: unknown) => ({
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body)
})
const UNKNOWN_ITEM = '00000000-0000-4000-8000-000000000000'
const HEADERLESS_READS = [
  { route: 'GET /sync/manifest', path: '/sync/manifest', status: 200 },
  { route: 'GET /sync/changes', path: '/sync/changes?since=0', status: 200 },
  {
    route: 'POST /sync/pull',
    path: '/sync/pull',
    init: json({ itemIds: [UNKNOWN_ITEM] }),
    status: 200
  },
  {
    route: 'POST /sync/records/pull',
    path: '/sync/records/pull',
    init: json({ itemIds: [UNKNOWN_ITEM] }),
    status: 200
  },
  { route: 'GET /sync/items/:id', path: `/sync/items/${UNKNOWN_ITEM}`, status: 404 },
  { route: 'GET /sync/packs', path: '/sync/packs', status: 200 },
  { route: 'GET /sync/crdt/updates', path: '/sync/crdt/updates?note_id=note_1', status: 200 },
  {
    route: 'POST /sync/crdt/updates/batch',
    path: '/sync/crdt/updates/batch',
    init: json({ notes: [{ noteId: 'note_1' }] }),
    status: 200
  },
  { route: 'GET /sync/crdt/snapshot/:noteId', path: '/sync/crdt/snapshot/note_1', status: 200 },
  // Blob reads have nothing to serve: 404, and 501 where presign is not configured.
  { route: 'GET /sync/blob/:key', path: '/sync/blob/item-1', status: 404 },
  {
    route: 'HEAD /sync/attachments/chunks/:hash',
    path: '/sync/attachments/chunks/abc',
    init: { method: 'HEAD' },
    status: 404
  },
  {
    route: 'GET /sync/attachments/chunks/:hash',
    path: '/sync/attachments/chunks/abc',
    status: 404
  },
  {
    route: 'GET /sync/attachments/:id/manifest',
    path: '/sync/attachments/att-1/manifest',
    status: 404
  },
  {
    route: 'GET /sync/attachments/upload/:id',
    path: '/sync/attachments/upload/session-1',
    status: 404
  },
  {
    route: 'POST /sync/attachments/presign-batch',
    path: '/sync/attachments/presign-batch',
    init: json({ chunkHashes: ['abc'] }),
    status: 501
  },
  // Without an Upgrade header the route refuses after the middleware has run.
  { route: 'GET /sync/ws', path: '/sync/ws', status: 426 }
]

describe.each([
  { plan: 'plus', maxVaults: 1 },
  { plan: 'believer', maxVaults: null }
])('header-less reads on a $plan account with no vaults', ({ plan, maxVaults }) => {
  beforeEach(() => {
    harness.raw.prepare('DELETE FROM sync_vaults WHERE user_id = ?').run(USER_ID)
    grant(plan, maxVaults)
  })

  it.each(HEADERLESS_READS)('$route answers from an empty vault and creates none', async (read) => {
    const res = await request(read.path, read.init)

    expect(res.status).toBe(read.status)
    expect(vaultIds()).toEqual([])
  })

  it('leave the real vault free to register', async () => {
    for (const read of HEADERLESS_READS.slice(0, 3)) {
      expect((await request(read.path, read.init)).status).toBe(200)
    }

    const registered = await request('/sync/vaults', {
      ...json({ vaultUuid: REAL_VAULT, encryptedName: 'name', nameNonce: 'nonce' })
    })

    expect(registered.status).toBe(200)
    expect(vaultIds()).toEqual([REAL_VAULT])
  })

  // Compat: a build that predates the header still gets `default` on its
  // first push, exactly as before. The item is refused on its own (per-item
  // outcome), after the middleware has run.
  it('still creates `default` on a header-less write', async () => {
    const res = await request('/sync/push', json({ items: [{ id: 'task-1', type: 'task' }] }))

    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ accepted: [], rejected: [{ id: 'task-1' }] })
    expect(vaultIds()).toEqual(['default'])
  })
})
