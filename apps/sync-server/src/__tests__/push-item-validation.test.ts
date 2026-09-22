import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import type { AppContext, Bindings } from '../types'

/**
 * `/sync/push` rejects a schema-invalid item BY ITEM (#2320).
 *
 * The batch used to be validated as one value, so a single item the schema
 * refused failed all 100 with a 400 that named no item. The client cannot learn
 * which queue row to retire from that verdict, so it marked nothing and
 * re-sent the identical batch every cycle: one clock-less note stopped a paid
 * vault from syncing at all. These tests pin the per-item verdict and the
 * request-level checks that must still fail as a request.
 */

const USER_ID = 'user-item-validation'
const DEVICE_ID = 'device-item-validation'
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
let env: Bindings
let signingKey: CryptoKey

const now = (): number => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number): string => Buffer.alloc(length, fill).toString('base64')

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
    .run(USER_ID, 'items@example.com', now(), now())

  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())

  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())

  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
}

const buildApp = (): Hono<AppContext> => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}

type WireItem = Record<string, unknown>

const signedItem = async (
  itemId: string,
  type: 'task' | 'note' = 'task',
  tick = 1
): Promise<WireItem> => {
  const base = {
    id: itemId,
    type,
    operation: 'update' as const,
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: b64(64, 0x33),
    dataNonce: b64(24, 0x44),
    metadata: { clock: { [DEVICE_ID]: tick } }
  }
  const signature = Buffer.from(
    await crypto.subtle.sign(
      'Ed25519',
      signingKey,
      encodeSignaturePayload(base, 'SYNC_ITEM') as unknown as ArrayBuffer
    )
  ).toString('base64')

  return {
    id: base.id,
    type: base.type,
    operation: base.operation,
    encryptedKey: base.encryptedKey,
    keyNonce: base.keyNonce,
    encryptedData: base.encryptedData,
    dataNonce: base.dataNonce,
    clock: { [DEVICE_ID]: tick },
    signature,
    signerDeviceId: DEVICE_ID
  }
}

/** The exact shape that blocked the vault: a note with no clock metadata. */
const clocklessNote = async (itemId: string): Promise<WireItem> => {
  const item = await signedItem(itemId, 'note')
  delete item.clock
  return item
}

const push = async (app: Hono<AppContext>, items: unknown[]): Promise<Response> =>
  app.request(
    '/sync/push',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items })
    },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

const itemRow = (itemId: string): Record<string, unknown> | undefined =>
  harness.raw
    .prepare('SELECT * FROM sync_items WHERE user_id = ? AND item_id = ?')
    .get(USER_ID, itemId) as Record<string, unknown> | undefined

beforeEach(async () => {
  harness = createSqliteD1()
  env = {
    DB: harness.db,
    STORAGE: createMemoryR2(),
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

describe('#given a batch with one schema-invalid item', () => {
  it('#then the valid items still commit and only the bad one is rejected', async () => {
    const app = buildApp()
    const res = await push(app, [
      await signedItem('task-ok-1'),
      await clocklessNote('note-no-clock'),
      await signedItem('task-ok-2')
    ])

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accepted: string[]
      rejected: Array<{ id: string; reason: string }>
    }

    expect(body.accepted.sort()).toEqual(['task-ok-1', 'task-ok-2'])
    expect(body.rejected).toHaveLength(1)
    expect(body.rejected[0].id).toBe('note-no-clock')
    expect(body.rejected[0].reason).toContain('SYNC_INVALID_ITEM')

    expect(itemRow('task-ok-1')).toBeDefined()
    expect(itemRow('task-ok-2')).toBeDefined()
    expect(itemRow('note-no-clock')).toBeUndefined()
  })

  it('#then the rejection reason carries the issue so the client can log it', async () => {
    const app = buildApp()
    const res = await push(app, [await clocklessNote('note-diagnosable')])

    const body = (await res.json()) as { rejected: Array<{ id: string; reason: string }> }
    expect(body.rejected[0].reason).toContain('requires clock metadata')
  })
})

describe('#given a batch where every item is invalid', () => {
  it('#then the response is a normal per-item verdict, not an error', async () => {
    const app = buildApp()
    const res = await push(app, [await clocklessNote('note-a'), await clocklessNote('note-b')])

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accepted: string[]
      rejected: Array<{ id: string }>
      maxCursor: number
      serverTime: number
    }

    expect(body.accepted).toEqual([])
    expect(body.rejected.map((entry) => entry.id).sort()).toEqual(['note-a', 'note-b'])
    expect(body.maxCursor).toBe(0)
    expect(body.serverTime).toBeGreaterThan(0)
  })
})

describe('#given an item with no usable id', () => {
  // Unaddressable in `rejected[]`, so it is dropped silently. The client marks
  // every id it sent and got no verdict for as failed, so the row still leaves
  // the queue — what must not happen is the sibling item losing its write.
  it('#then it is dropped without taking the rest of the batch with it', async () => {
    const app = buildApp()
    const res = await push(app, [
      { type: 'note', operation: 'update' },
      await signedItem('task-ok-3')
    ])

    expect(res.status).toBe(200)
    const body = (await res.json()) as {
      accepted: string[]
      rejected: Array<{ id: string }>
    }

    expect(body.accepted).toEqual(['task-ok-3'])
    expect(body.rejected).toEqual([])
    expect(itemRow('task-ok-3')).toBeDefined()
  })
})

describe('#given a malformed request envelope', () => {
  it('#then it is still refused as a request, not as items', async () => {
    const app = buildApp()

    const empty = await push(app, [])
    expect(empty.status).toBe(400)

    const overLimit = await push(app, new Array<Record<string, unknown>>(101).fill({ id: 'x' }))
    expect(overLimit.status).toBe(400)
  })
})
