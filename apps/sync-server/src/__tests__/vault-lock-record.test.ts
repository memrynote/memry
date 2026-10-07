import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { resolveSyncSubscription } from '../lib/sync-types'
import { logRecordPushBatch, logRecordQueryBatch } from '../services/sync-telemetry'
import type { AppContext, Bindings } from '../types'

/**
 * Read-only locks (#2606) sync as their own record type, `vault_lock`, with
 * ids `note:<noteId>` and `folder:<path>`. Unlocking is a `locked: false`
 * update, never a delete. A client only receives the type when it names it in
 * X-Memry-Sync-Types, so builds that predate locks never see one.
 */

const USER_ID = 'user-vault-locks'
const DEVICE_ID = 'device-vault-locks'
const VAULT_ID = 'default'
const LOCK_AWARE_TYPES = 'note,task,vault_lock'

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
    .run(USER_ID, 'locks@example.com', now(), now())

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
  type: 'vault_lock' | 'note',
  tick: number
): Promise<WireItem> => {
  const base = {
    id: itemId,
    type,
    operation: 'update' as const,
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: b64(64, 0x30 + tick),
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

  const { metadata: _metadata, cryptoVersion: _cryptoVersion, ...wire } = base
  return { ...wire, clock: { [DEVICE_ID]: tick }, signature, signerDeviceId: DEVICE_ID }
}

const request = (
  app: Hono<AppContext>,
  path: string,
  init: RequestInit = {},
  headers: Record<string, string> = {}
): Promise<Response> =>
  Promise.resolve(
    app.request(
      path,
      { ...init, headers: { 'Content-Type': 'application/json', ...headers } },
      env as unknown as Record<string, unknown>,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined
      } as unknown as ExecutionContext
    )
  )

const push = async (
  app: Hono<AppContext>,
  items: WireItem[]
): Promise<{ accepted: string[]; rejected: Array<{ id: string; reason: string }> }> => {
  const res = await request(app, '/sync/push', { method: 'POST', body: JSON.stringify({ items }) })
  expect(res.status).toBe(200)
  return (await res.json()) as {
    accepted: string[]
    rejected: Array<{ id: string; reason: string }>
  }
}

const changedIds = async (app: Hono<AppContext>, types?: string): Promise<string[]> => {
  const res = await request(
    app,
    '/sync/changes?cursor=0',
    {},
    types ? { 'X-Memry-Sync-Types': types } : {}
  )
  expect(res.status).toBe(200)
  const body = (await res.json()) as { items: Array<{ id: string; type: string }> }
  return body.items.map((item) => `${item.type}/${item.id}`).sort()
}

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
  vi.restoreAllMocks()
})

describe('vault_lock records (#2606)', () => {
  it('accepts a note lock and a folder lock in a push with their neighbours, stored as vault_lock', async () => {
    const app = buildApp()

    const body = await push(app, [
      await signedItem('note:note-1', 'vault_lock', 1),
      await signedItem('folder:projects/plan', 'vault_lock', 1),
      await signedItem('note-1', 'note', 1)
    ])

    expect(body.rejected).toEqual([])
    expect(body.accepted.sort()).toEqual(['folder:projects/plan', 'note-1', 'note:note-1'])
    expect(
      harness.raw
        .prepare(
          `SELECT item_id AS id FROM sync_items WHERE user_id = ? AND item_type = 'vault_lock' ORDER BY item_id`
        )
        .all(USER_ID)
    ).toEqual([{ id: 'folder:projects/plan' }, { id: 'note:note-1' }])
  })

  it('accepts an unlock as a newer update of the same record, never a delete', async () => {
    const app = buildApp()
    await push(app, [await signedItem('note:note-1', 'vault_lock', 1)])

    const unlock = await push(app, [await signedItem('note:note-1', 'vault_lock', 2)])

    expect(unlock.accepted).toEqual(['note:note-1'])
    expect(
      harness.raw
        .prepare(`SELECT deleted_at AS deletedAt FROM sync_items WHERE user_id = ? AND item_id = ?`)
        .get(USER_ID, 'note:note-1')
    ).toEqual({ deletedAt: null })
  })

  it('pulls locks only for a client that names vault_lock, never for a legacy one', async () => {
    const app = buildApp()
    await push(app, [
      await signedItem('note:note-1', 'vault_lock', 1),
      await signedItem('note-1', 'note', 1)
    ])

    expect(await changedIds(app, LOCK_AWARE_TYPES)).toEqual([
      'note/note-1',
      'vault_lock/note:note-1'
    ])
    expect(await changedIds(app, 'note,task')).toEqual(['note/note-1'])
    expect(await changedIds(app)).toEqual(['note/note-1'])
    expect(resolveSyncSubscription(LOCK_AWARE_TYPES).recordTypes).toContain('vault_lock')
    expect(resolveSyncSubscription(null).recordTypes).not.toContain('vault_lock')
  })

  it('pulls a pushed lock by id for a lock-aware client only', async () => {
    const app = buildApp()
    await push(app, [await signedItem('folder:archive', 'vault_lock', 1)])
    const pull = async (headers: Record<string, string>) => {
      const res = await request(
        app,
        '/sync/pull',
        { method: 'POST', body: JSON.stringify({ itemIds: ['folder:archive'] }) },
        headers
      )
      expect(res.status).toBe(200)
      return ((await res.json()) as { items: Array<{ id: string; type: string }> }).items
    }

    expect(await pull({ 'X-Memry-Sync-Types': LOCK_AWARE_TYPES })).toEqual([
      expect.objectContaining({ id: 'folder:archive', type: 'vault_lock' })
    ])
    expect(await pull({})).toEqual([])
  })

  it('reports vault_lock traffic under the locks telemetry domain', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    logRecordPushBatch({
      endpoint: '/sync/push',
      vaultId: VAULT_ID,
      latencyMs: 10,
      outcomes: [{ id: 'note:note-1', type: 'vault_lock', accepted: true, serverCursor: 1 }]
    })
    logRecordQueryBatch({
      endpoint: '/sync/changes',
      operation: 'changes',
      latencyMs: 10,
      itemTypes: ['vault_lock', 'vault_lock']
    })

    const [pushLog, queryLog] = infoSpy.mock.calls.map(
      (call) => JSON.parse(String(call[0])) as Record<string, unknown>
    )
    expect(pushLog.domains).toMatchObject({ locks: { accepted: 1 } })
    expect(pushLog.domainTypes).toMatchObject({ vault_lock: { accepted: 1, rejected: 0 } })
    expect(queryLog.domains).toEqual({ locks: 2 })
    expect(queryLog.domainTypes).toEqual({ vault_lock: 2 })
  })
})
