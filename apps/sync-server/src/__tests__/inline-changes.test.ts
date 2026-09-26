import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import type { AppContext, Bindings } from '../types'

/**
 * #2292: `GET /sync/changes?inline=1` against the real routes, services, SQL
 * and schema. Only auth is stubbed (see legacy-client-compat.test.ts).
 */

const USER_ID = 'user-inline'
const DEVICE_ID = 'device-inline'
const VAULT_ID = 'default'

vi.mock('../middleware/auth', () => ({
  authMiddleware: async (
    c: { set: (k: string, v: unknown) => void },
    next: () => Promise<void>
  ) => {
    c.set('userId', USER_ID)
    c.set('deviceId', DEVICE_ID)
    await next()
  }
}))

const { sync } = await import('../routes/sync')

let harness: SqliteD1
let storage: R2Bucket
let env: Bindings
let signingKey: CryptoKey

const now = () => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')

/** Stored JSON of 50 000 random bytes is ~66.7 KB: just over the 64 KiB inline ceiling. */
const OVERSIZE_DATA_BYTES = 50_000

const seed = async (): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKey = keyPair.privateKey
  const publicKey = Buffer.from(
    (await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      keyPair.publicKey
    )) as ArrayBuffer
  ).toString('base64')

  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'inline@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Inline desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
}

const buildApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}

interface PushSpec {
  id: string
  type?: 'task' | 'project'
  tick?: number
  dataBytes?: number
  deletedAt?: number
}

const signedItem = async ({ id, type = 'task', tick = 1, dataBytes = 64, deletedAt }: PushSpec) => {
  const base = {
    id,
    type,
    operation: deletedAt === undefined ? ('update' as const) : ('delete' as const),
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    // Random, not a fill byte: the content hash keys the R2 object, and two
    // equal payloads of different ids must still be separate objects.
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(dataBytes))).toString(
      'base64'
    ),
    dataNonce: b64(24, 0x44),
    metadata: { clock: { [DEVICE_ID]: tick } },
    ...(deletedAt === undefined ? {} : { deletedAt })
  }
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      signingKey,
      encodeSignaturePayload(base, 'SYNC_ITEM') as unknown as ArrayBuffer
    )
  ).toString('base64')

  const { metadata: _metadata, cryptoVersion: _cryptoVersion, ...wire } = base
  return { ...wire, clock: { [DEVICE_ID]: tick }, signature, signerDeviceId: DEVICE_ID }
}

const request = (app: ReturnType<typeof buildApp>, path: string, init: RequestInit = {}) =>
  app.request(
    path,
    { ...init, headers: { 'Content-Type': 'application/json' } },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

const push = async (app: ReturnType<typeof buildApp>, specs: PushSpec[]): Promise<void> => {
  for (let i = 0; i < specs.length; i += 100) {
    const items = await Promise.all(specs.slice(i, i + 100).map(signedItem))
    const res = await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items })
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { accepted: string[] }
    expect(body.accepted).toHaveLength(items.length)
  }
}

/** The raw `items` array text of a `/sync/pull` response: `{"items":[...]}` minus the wrapper. */
const pullItemsText = async (app: ReturnType<typeof buildApp>, itemIds: string[]) => {
  const res = await request(app, '/sync/pull', {
    method: 'POST',
    body: JSON.stringify({ itemIds })
  })
  expect(res.status).toBe(200)
  const text = await res.text()
  expect(text.startsWith('{"items":')).toBe(true)
  return text.slice('{"items":'.length, -1)
}

interface ChangesBody {
  items: Array<{ id: string; type: string }>
  deleted: string[]
  hasMore: boolean
  nextCursor: number
  inline?: Array<{ id: string; type: string; deletedAt?: number }>
}

const changes = async (app: ReturnType<typeof buildApp>, query: string) => {
  const res = await request(app, `/sync/changes?${query}`)
  const text = await res.text()
  return { status: res.status, text, body: JSON.parse(text) as ChangesBody }
}

beforeEach(async () => {
  harness = createSqliteD1()
  storage = createMemoryR2()
  env = {
    DB: harness.db,
    STORAGE: storage,
    ENVIRONMENT: 'development',
    USER_SYNC_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) })
    },
    RATE_LIMITER: {
      idFromName: (name: string) => name,
      get: () => ({
        fetch: async () => Response.json({ count: 1, windowStart: Math.floor(Date.now() / 1000) })
      })
    }
  } as unknown as Bindings
  await seed()
})

afterEach(() => {
  harness.close()
})

describe('GET /sync/changes?inline=1 (#2292)', () => {
  // #2292
  it('inlines each small item byte-identical to what /sync/pull returns for it', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-a' }, { id: 'task-b', tick: 2 }])

    const inlinePage = await changes(app, 'cursor=0&limit=500&inline=1')
    const pulled = await pullItemsText(app, ['task-a', 'task-b'])

    expect(inlinePage.status).toBe(200)
    expect(inlinePage.text).toContain(`"inline":${pulled}`)
    expect(inlinePage.body.items.map((item) => item.id)).toEqual(['task-a', 'task-b'])
  })

  // #2292
  it('inlines a tombstone, with deletedAt, for its deleted id', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-gone' }])
    await push(app, [{ id: 'task-gone', tick: 2, deletedAt: 1_790_000_000 }])

    const page = await changes(app, 'cursor=0&inline=1')

    expect(page.body.deleted).toEqual(['task-gone'])
    expect(page.body.inline).toEqual([
      expect.objectContaining({ id: 'task-gone', operation: 'delete', deletedAt: 1_790_000_000 })
    ])
    expect(page.text).toContain(`"inline":${await pullItemsText(app, ['task-gone'])}`)
  })

  // #2292
  it('keeps the ref of a row over 64 KiB but leaves it out of inline', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-big', dataBytes: OVERSIZE_DATA_BYTES }, { id: 'task-small' }])

    const size = harness.raw
      .prepare('SELECT size_bytes FROM sync_items WHERE item_id = ?')
      .get('task-big') as { size_bytes: number }
    expect(size.size_bytes).toBeGreaterThan(64 * 1024)

    const page = await changes(app, 'cursor=0&inline=1')

    expect(page.body.items.map((item) => item.id)).toEqual(['task-big', 'task-small'])
    expect(page.body.inline?.map((item) => item.id)).toEqual(['task-small'])
  })

  // #2292
  it('inlines neither row of an id whose same-id sibling of another type is too large', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'shared', type: 'task' },
      { id: 'shared', type: 'project', dataBytes: OVERSIZE_DATA_BYTES },
      { id: 'task-other' }
    ])

    const page = await changes(app, 'cursor=0&inline=1')

    expect(page.body.items).toHaveLength(3)
    expect(page.body.inline?.map((item) => item.id)).toEqual(['task-other'])
  })

  // #2292
  it('clamps an inline page to 100 refs and reports hasMore', async () => {
    const app = buildApp()
    await push(
      app,
      Array.from({ length: 150 }, (_, i) => ({ id: `task-${String(i).padStart(3, '0')}` }))
    )
    const cursors = harness.raw
      .prepare('SELECT server_cursor FROM sync_items ORDER BY server_cursor ASC')
      .all() as Array<{ server_cursor: number }>

    const page = await changes(app, 'cursor=0&limit=500&inline=1')

    expect(page.body.items).toHaveLength(100)
    expect(page.body.inline).toHaveLength(100)
    expect(page.body.hasMore).toBe(true)
    expect(page.body.nextCursor).toBe(cursors[99].server_cursor)
  })

  // #2292
  it('answers 200 without the item whose blob is missing', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-lost' }, { id: 'task-kept' }])
    const { blob_key } = harness.raw
      .prepare('SELECT blob_key FROM sync_items WHERE item_id = ?')
      .get('task-lost') as { blob_key: string }
    await storage.delete(blob_key)

    const page = await changes(app, 'cursor=0&inline=1')

    expect(page.status).toBe(200)
    expect(page.body.items.map((item) => item.id)).toEqual(['task-lost', 'task-kept'])
    expect(page.body.inline?.map((item) => item.id)).toEqual(['task-kept'])
  })

  // #2292: inlining never fails a page; the id falls back to /sync/pull.
  it('answers 200 without the item whose row the pull path cannot serve', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-corrupt' }, { id: 'task-fine' }])
    harness.raw.prepare("UPDATE sync_items SET clock = '{' WHERE item_id = ?").run('task-corrupt')

    const page = await changes(app, 'cursor=0&inline=1')

    expect(page.status).toBe(200)
    expect(page.body.inline?.map((item) => item.id)).toEqual(['task-fine'])
  })

  // #2292: old clients never ask, and get exactly today's response.
  it('sends no inline key to a request that did not ask for it', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-plain' }])

    const page = await changes(app, 'cursor=0&limit=500')

    expect(page.status).toBe(200)
    expect(Object.keys(page.body).sort()).toEqual([
      'deleted',
      'hasMore',
      'items',
      'nextCursor',
      'serverTimeMs'
    ])
  })

  // #2292
  it.each(['0', 'yes', ''])('rejects inline=%s with 400', async (value) => {
    const app = buildApp()

    const res = await request(app, `/sync/changes?cursor=0&inline=${value}`)

    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: { code: 'VALIDATION_ERROR' } })
  })
})
