import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from '../__tests__/d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import type { AppContext, Bindings } from '../types'
import { compactOneRange, compactVault } from './pack-compaction'
import { extractEntry, parsePack, type PackedEntry } from './pack-format'
import {
  RECORD_SYNC_ITEM_TYPES,
  RecordPackEntryMetaSchema,
  RecordPullItemResponseSchema,
  type RecordPullItemResponse,
  type RecordSyncItemType
} from '@memry/contracts/sync-api'

/**
 * #5227: a record pack entry is one POST /sync/pull item split into identity,
 * meta and payload (protocol 08 §8.4.2). Real push and pull routes, services,
 * SQL and schema; only auth is stubbed.
 */

const USER_ID = 'user-record-pack'
const DEVICE_ID = 'device-record-pack'
const VAULT_ID = 'default'
const SCOPE = { userId: USER_ID, vaultId: VAULT_ID }

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

const seedAccount = async (): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKey = keyPair.privateKey
  const publicKey = Buffer.from(
    await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      keyPair.publicKey
    )
  ).toString('base64')
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, 'record-pack@example.com', 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Record pack desktop', 'desktop', '1.0.0', ?, ?, ?)`
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
type App = ReturnType<typeof buildApp>

interface PushSpec {
  id: string
  type?: RecordSyncItemType
  operation?: 'create' | 'update'
  clock?: Record<string, number>
  deletedAt?: number
}

const signedItem = async ({ id, type = 'task', operation, clock, deletedAt }: PushSpec) => {
  const base = {
    id,
    type,
    operation: deletedAt === undefined ? (operation ?? ('update' as const)) : ('delete' as const),
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    dataNonce: b64(24, 0x44),
    ...(clock ? { metadata: { clock } } : {}),
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
  return { ...wire, ...(clock ? { clock } : {}), signature, signerDeviceId: DEVICE_ID }
}

const request = (app: App, path: string, body: unknown) =>
  app.request(
    path,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Memry-Sync-Types': [...RECORD_SYNC_ITEM_TYPES, 'purged_tombstones'].join(',')
      },
      body: JSON.stringify(body)
    },
    env,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

const push = async (app: App, specs: PushSpec[]): Promise<void> => {
  const items = await Promise.all(specs.map(signedItem))
  const res = await request(app, '/sync/push', { items })
  const body = (await res.json()) as { accepted: string[] }
  expect(body.accepted).toEqual(specs.map((spec) => spec.id))
}

const pull = async (app: App, itemIds: string[]): Promise<RecordPullItemResponse[]> => {
  const res = await request(app, '/sync/pull', { itemIds })
  expect(res.status).toBe(200)
  const body: { items: RecordPullItemResponse[] } = await res.json()
  return body.items
}

/** Every record entry of every record pack, rebuilt into a pull item (§8.4.2). */
const packedRecordItems = async (): Promise<
  Array<{ entry: PackedEntry; item: RecordPullItemResponse }>
> => {
  const keys = harness.raw
    .prepare(`SELECT pack_key FROM pack_index WHERE item_kind = 'record' ORDER BY min_cursor`)
    .all() as Array<{ pack_key: string }>
  const out: Array<{ entry: PackedEntry; item: RecordPullItemResponse }> = []
  for (const { pack_key: key } of keys) {
    const bytes = new Uint8Array(await (await storage.get(key))!.arrayBuffer())
    for (const entry of (await parsePack(bytes)).entries) {
      const at = entry.id.indexOf(':')
      const meta = RecordPackEntryMetaSchema.parse(entry.meta)
      const blob = JSON.parse(new TextDecoder().decode(extractEntry(bytes, entry))) as unknown
      const item = RecordPullItemResponseSchema.parse({
        ...meta,
        id: entry.id.slice(at + 1),
        type: entry.id.slice(0, at),
        blob
      })
      out.push({ entry, item })
    }
  }
  return out
}

const rowOf = (itemId: string) =>
  harness.raw
    .prepare('SELECT blob_key, server_cursor FROM sync_items WHERE user_id = ? AND item_id = ?')
    .get(USER_ID, itemId) as { blob_key: string; server_cursor: number }

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
  await seedAccount()
})

afterEach(() => {
  harness.close()
  vi.restoreAllMocks()
})

describe('record packs carry the pull item (#5227)', () => {
  it('packs every record, tombstones included, exactly as POST /sync/pull returns it', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-live', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-gone', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'folder/a:b', type: 'folder_config', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'tag-1', type: 'tag_definition', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    await push(app, [
      { id: 'task-live', clock: { [DEVICE_ID]: 2 } },
      { id: 'task-gone', clock: { [DEVICE_ID]: 2 }, deletedAt: now() }
    ])

    await compactVault(harness.db, storage, SCOPE)

    const packed = await packedRecordItems()
    const ids = ['task-live', 'task-gone', 'folder/a:b', 'tag-1']
    const pulled = await pull(app, ids)
    expect(pulled).toHaveLength(ids.length)
    expect(packed.map(({ item }) => item.id).toSorted()).toEqual(ids.toSorted())
    for (const expected of pulled) {
      const match = packed.find(
        ({ item }) => item.id === expected.id && item.type === expected.type
      )
      expect(match?.item).toEqual(expected)
      expect(match?.entry.sortKey).toBe(rowOf(expected.id).server_cursor)
      expect(match?.entry.sourceKey).toBe(rowOf(expected.id).blob_key)
    }
    const tombstone = packed.find(({ item }) => item.id === 'task-gone')!.item
    expect(tombstone.operation).toBe('delete')
    expect(tombstone.deletedAt).toBeGreaterThan(0)
  })

  it('a push racing compaction leaves the entry out, and its new version above the pack', async () => {
    const app = buildApp()
    await push(app, [
      { id: 'task-a', operation: 'create', clock: { [DEVICE_ID]: 1 } },
      { id: 'task-b', operation: 'create', clock: { [DEVICE_ID]: 1 } }
    ])
    const raced = rowOf('task-a')
    // The push lands after selection read task-a's row and before its R2 GET.
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === raced.blob_key) await push(app, [{ id: 'task-a', clock: { [DEVICE_ID]: 2 } }])
      return realGet(key)
    })

    const result = await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect(result.holes).toEqual(['task:task-a'])
    expect((await packedRecordItems()).map(({ item }) => item)).toEqual(await pull(app, ['task-b']))
    expect(rowOf('task-a').server_cursor).toBeGreaterThan(result.maxSortValue)
  })

  it('an entry whose old payload outlived the race is that old version, whole', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-a', operation: 'create', clock: { [DEVICE_ID]: 1 } }])
    const before = await pull(app, ['task-a'])
    const raced = rowOf('task-a')
    const oldBytes = await (await storage.get(raced.blob_key))!.arrayBuffer()
    // Push Stage 8 deletes the replaced object best-effort; here the GET
    // reaches it before that delete does.
    const realGet = storage.get.bind(storage)
    vi.spyOn(storage, 'get').mockImplementation(async (key: string) => {
      if (key === raced.blob_key) {
        await push(app, [{ id: 'task-a', clock: { [DEVICE_ID]: 2 } }])
        await storage.put(raced.blob_key, oldBytes)
      }
      return realGet(key)
    })

    await compactOneRange(harness.db, storage, SCOPE, 'record')
    vi.mocked(storage.get).mockRestore()

    expect((await packedRecordItems()).map(({ item }) => item)).toEqual(before)
  })
})
