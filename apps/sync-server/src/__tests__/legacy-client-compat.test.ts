import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import type { AppContext, Bindings } from '../types'
import {
  NoteBodyChangeSchema,
  RECORD_SYNC_ITEM_TYPES,
  type RecordChangesResponse
} from '@memry/contracts/sync-api'

const USER_ID = 'user-legacy'
const DEVICE_ID = 'device-legacy'
const VAULT_ID = 'default'

// Auth is the ONE thing stubbed here. It is orthogonal to the client gate (it
// runs before it and is unchanged by this feature), and standing up real JWT
// issuance would add a signing dance without adding a compat guarantee.
// Everything below auth -- the gate, paid-sync, sync-types, the services, and
// D1 itself -- is the real implementation.
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

const now = () => Math.floor(Date.now() / 1000)

const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')

const seed = async (): Promise<void> => {
  const keyPair = (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, [
    'sign',
    'verify'
  ])) as CryptoKeyPair
  signingKey = keyPair.privateKey
  // Workers' `exportKey` overloads do not model raw Ed25519 export, which Node's
  // WebCrypto (what these tests run on) supports.
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
    .run(USER_ID, 'legacy@example.com', now(), now())

  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())

  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Legacy desktop', 'desktop', '1.0.0', ?, ?, ?)`
    )
    .run(DEVICE_ID, USER_ID, publicKey, now(), now())

  harness.raw
    .prepare(
      `INSERT INTO sync_vaults (id, user_id, vault_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)`
    )
    .run('vault-row', USER_ID, VAULT_ID, now(), now())
}

const setPolicy = (
  platform: string,
  fields: { minWriteVersion?: string | null; writesEnabled?: number }
): void => {
  harness.raw
    .prepare(
      `INSERT INTO client_policies (platform, min_write_version, writes_enabled, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (platform) DO UPDATE SET
         min_write_version = excluded.min_write_version,
         writes_enabled = excluded.writes_enabled,
         updated_at = excluded.updated_at`
    )
    .run(platform, fields.minWriteVersion ?? null, fields.writesEnabled ?? 1, now())
}

const buildApp = () => {
  const app = new Hono<AppContext>()
  app.onError(errorHandler)
  app.route('/sync', sync)
  return app
}

const pushItem = async (itemId: string, tick = 1) => {
  const base = {
    id: itemId,
    type: 'task' as const,
    operation: 'update' as const,
    cryptoVersion: 1,
    // Lengths are load-bearing: validateEncryptedFields checks 24-byte nonces
    // and a >= 48-byte wrapped key before anything is written.
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

const request = (
  app: ReturnType<typeof buildApp>,
  path: string,
  init: RequestInit & { clientHeader?: string } = {}
) => {
  const { clientHeader, ...rest } = init
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...((rest.headers as Record<string, string>) ?? {})
  }
  if (clientHeader) headers['x-memry-client'] = clientHeader
  // The push handler fires its broadcast through `executionCtx.waitUntil`, so
  // the request needs one exactly as the Workers runtime supplies.
  return app.request(
    path,
    { ...rest, headers },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )
}

const itemRow = (itemId: string) =>
  harness.raw
    .prepare('SELECT * FROM sync_items WHERE user_id = ? AND item_id = ?')
    .get(USER_ID, itemId) as Record<string, unknown> | undefined

beforeEach(async () => {
  harness = createSqliteD1()
  env = {
    DB: harness.db,
    STORAGE: createMemoryR2(),
    ENVIRONMENT: 'development',
    // The push handler fans a change notification out through the Durable
    // Object after a successful write. Nothing here asserts on the broadcast,
    // but the call has to exist or every push 500s on the way out.
    USER_SYNC_STATE: {
      idFromName: (name: string) => name,
      get: () => ({ fetch: async () => new Response(null, { status: 204 }) })
    },
    // The real rate-limit middleware runs in this suite (auth is mocked, the
    // limiter is not). Nothing here exercises limits, so the counter stub
    // always answers "first request of a fresh window".
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
  vi.useRealTimers()
})

describe('legacy (header-less) clients', () => {
  it('writes items exactly as before, with NULL attribution', async () => {
    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-1')] })
    })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ accepted: ['task-1'], rejected: [] })

    const row = itemRow('task-1')
    expect(row).toBeDefined()
    expect(row?.client_platform).toBeNull()
    expect(row?.client_version).toBeNull()
    expect(row?.item_type).toBe('task')
    expect(row?.version).toBe(1)
  })

  it('is unaffected by a kill switch aimed at another platform', async () => {
    setPolicy('ios', { writesEnabled: 0 })
    setPolicy('desktop', { writesEnabled: 0 })

    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-2')] })
    })

    // A header-less request is legacy desktop and is NEVER gated -- not even by
    // the `desktop` row. Gating it would lock out every build shipped to date.
    expect(res.status).toBe(200)
    expect(itemRow('task-2')).toBeDefined()
  })

  it('is unaffected by a version floor above its own version', async () => {
    setPolicy('desktop', { minWriteVersion: '99.0.0' })

    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-3')] })
    })

    expect(res.status).toBe(200)
  })

  it('gets the pre-existing status response shape, with no policy field', async () => {
    const app = buildApp()
    const res = await request(app, '/sync/status')

    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['connected', 'pendingItems', 'serverTime'])
    expect(body).not.toHaveProperty('clientPolicy')
  })

  it('reads changes unchanged', async () => {
    const app = buildApp()
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-4')] })
    })

    const res = await request(app, '/sync/changes?cursor=0')
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({ hasMore: false })
  })

  // #2295: note bodies now carry a cursor, but only a client that declares
  // note_body is served them. A header-less client and a client that declares
  // record types only get the exact response shape they always did.
  it('never sees note bodies in changes, with or without a record-only type header', async () => {
    const app = buildApp()
    await request(app, '/sync/crdt/updates', {
      method: 'POST',
      body: JSON.stringify({ noteId: 'note_feed', updates: [Buffer.from([1]).toString('base64')] })
    })
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-feed')] })
    })

    const headerSets: Array<Record<string, string>> = [
      {},
      { 'X-Memry-Sync-Types': RECORD_SYNC_ITEM_TYPES.join(',') }
    ]
    for (const headers of headerSets) {
      const res = await request(app, '/sync/changes?cursor=0', { headers })
      const body = (await res.json()) as Record<string, unknown>
      expect(Object.keys(body).sort()).toEqual([
        'deleted',
        'hasMore',
        'items',
        'nextCursor',
        'serverTimeMs'
      ])
      expect(body).toMatchObject({
        items: [{ id: 'task-feed', type: 'task', serverCursor: 2 }],
        deleted: [],
        hasMore: false,
        nextCursor: 2
      })
    }
  })
})

// #2296: a client that retries a CRDT push after a timeout gets the response
// it would have got the first time, and the server keeps one row.
describe('retried CRDT update push (#2296)', () => {
  it('answers the same sequences and stores the update once', async () => {
    const app = buildApp()
    const body = JSON.stringify({
      noteId: 'note_retry',
      updates: [Buffer.from([1, 2]).toString('base64'), Buffer.from([3]).toString('base64')]
    })

    const first = await request(app, '/sync/crdt/updates', { method: 'POST', body })
    const retry = await request(app, '/sync/crdt/updates', { method: 'POST', body })

    expect(first.status).toBe(200)
    expect(retry.status).toBe(200)
    const firstBody = await first.json()
    expect(firstBody).toEqual({ sequences: [1, 2] })
    expect(await retry.json()).toEqual(firstBody)
    expect(
      harness.raw
        .prepare(`SELECT COUNT(*) AS n FROM crdt_updates WHERE note_id = 'note_retry'`)
        .get()
    ).toEqual({ n: 2 })
  })
})

describe('note_body subscribers (#2295)', () => {
  const deviceCursor = () =>
    (
      harness.raw
        .prepare('SELECT last_cursor_seen FROM device_sync_state WHERE device_id = ?')
        .get(DEVICE_ID) as { last_cursor_seen: number } | undefined
    )?.last_cursor_seen

  it('get the body in cursor order beside the record, and a body-only page moves the device cursor', async () => {
    const app = buildApp()
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-body')] })
    })
    await request(app, '/sync/crdt/updates', {
      method: 'POST',
      body: JSON.stringify({
        noteId: 'note_body_1',
        updates: [Buffer.from([7]).toString('base64')]
      })
    })

    const res = await request(app, '/sync/changes?cursor=0', {
      headers: { 'X-Memry-Sync-Types': 'task,note_body' }
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as RecordChangesResponse
    expect(body.items.map((item) => [item.id, item.serverCursor])).toEqual([['task-body', 1]])
    expect(
      (body.noteBodies ?? [])
        .map((entry) => NoteBodyChangeSchema.parse(entry))
        .map((entry) => [entry.op, entry.noteId, entry.cursor])
    ).toEqual([['update', 'note_body_1', 2]])
    expect(body.nextCursor).toBe(2)

    harness.raw.prepare('DELETE FROM device_sync_state').run()
    const bodyOnly = await request(app, '/sync/changes?cursor=1', {
      headers: { 'X-Memry-Sync-Types': 'note_body' }
    })
    expect(((await bodyOnly.json()) as RecordChangesResponse).items).toEqual([])
    expect(deviceCursor()).toBe(2)
  })

  // #2295 + #2292: a note_body subscriber that also asks inline=1 gets both on
  // one merged page, and nothing past the last row the page served.
  it('get inline record items and note bodies on one page when they also ask inline=1', async () => {
    const app = buildApp()
    const headers = { 'X-Memry-Sync-Types': 'task,note_body' }
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-in-1')] })
    })
    await request(app, '/sync/crdt/updates', {
      method: 'POST',
      body: JSON.stringify({
        noteId: 'note_inline',
        updates: [Buffer.from([5]).toString('base64')]
      })
    })
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-in-2')] })
    })

    const first = await request(app, '/sync/changes?cursor=0&limit=2&inline=1', { headers })
    expect(first.status).toBe(200)
    const page = (await first.json()) as RecordChangesResponse
    expect(page.items.map((item) => [item.id, item.serverCursor])).toEqual([['task-in-1', 1]])
    expect(
      (page.noteBodies ?? [])
        .map((entry) => NoteBodyChangeSchema.parse(entry))
        .map((entry) => [entry.op, entry.noteId, entry.cursor])
    ).toEqual([['update', 'note_inline', 2]])
    expect(page.nextCursor).toBe(2)
    expect(page.hasMore).toBe(true)

    // Byte-identical to /sync/pull, and never a row past nextCursor.
    const pulled = await request(app, '/sync/pull', {
      method: 'POST',
      headers,
      body: JSON.stringify({ itemIds: ['task-in-1'] })
    })
    const pulledItems = ((await pulled.json()) as { items: unknown[] }).items
    expect(page.inline).toEqual(pulledItems)

    const rest = await request(app, '/sync/changes?cursor=2&inline=1', { headers })
    const restPage = (await rest.json()) as RecordChangesResponse
    expect(restPage.items.map((item) => item.id)).toEqual(['task-in-2'])
    expect((restPage.inline as Array<{ id: string }>).map((item) => item.id)).toEqual(['task-in-2'])
    expect(restPage.noteBodies).toEqual([])
    expect(restPage.nextCursor).toBe(3)
    expect(restPage.hasMore).toBe(false)
  })
})

describe('identified clients', () => {
  it('stamps platform and version on the written row', async () => {
    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      clientHeader: 'ios/1.4.2+91',
      body: JSON.stringify({ items: [await pushItem('task-5')] })
    })

    expect(res.status).toBe(200)
    const row = itemRow('task-5')
    expect(row?.client_platform).toBe('ios')
    // The build suffix is recorded in the header but never stored: the floor
    // comparison is on the semver triple, and a build number is not orderable
    // across release branches.
    expect(row?.client_version).toBe('1.4.2')
  })

  it('re-stamps attribution when another platform rewrites the same row', async () => {
    const app = buildApp()
    await request(app, '/sync/push', {
      method: 'POST',
      clientHeader: 'ios/1.4.2',
      body: JSON.stringify({ items: [await pushItem('task-6')] })
    })
    await request(app, '/sync/push', {
      method: 'POST',
      body: JSON.stringify({ items: [await pushItem('task-6', 2)] })
    })

    const row = itemRow('task-6')
    expect(row?.version).toBe(2)
    expect(row?.client_platform).toBeNull()
  })

  it('is rejected with 426 below the floor, and writes nothing', async () => {
    setPolicy('ios', { minWriteVersion: '2.0.0' })

    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      clientHeader: 'ios/1.9.9',
      body: JSON.stringify({ items: [await pushItem('task-7')] })
    })

    expect(res.status).toBe(426)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'CLIENT_UPGRADE_REQUIRED', minVersion: '2.0.0' }
    })
    expect(itemRow('task-7')).toBeUndefined()
  })

  it('is rejected with 403 under the kill switch, and writes nothing', async () => {
    setPolicy('ios', { writesEnabled: 0 })

    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      clientHeader: 'ios/1.9.9',
      body: JSON.stringify({ items: [await pushItem('task-8')] })
    })

    expect(res.status).toBe(403)
    await expect(res.json()).resolves.toMatchObject({
      error: { code: 'PLATFORM_WRITES_DISABLED' }
    })
    expect(itemRow('task-8')).toBeUndefined()
  })

  it('still reads while writes are disabled', async () => {
    setPolicy('ios', { writesEnabled: 0 })

    const app = buildApp()
    const res = await request(app, '/sync/changes?cursor=0', { clientHeader: 'ios/1.0.0' })
    expect(res.status).toBe(200)
  })

  it('learns the flipped switch from status without attempting a write', async () => {
    setPolicy('ios', { writesEnabled: 0, minWriteVersion: '2.0.0' })

    const app = buildApp()
    const res = await request(app, '/sync/status', { clientHeader: 'ios/1.0.0' })

    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toMatchObject({
      clientPolicy: { platform: 'ios', writesEnabled: false, minWriteVersion: '2.0.0' }
    })
  })

  it('reports a permissive policy when no row exists for the platform', async () => {
    const app = buildApp()
    const res = await request(app, '/sync/status', { clientHeader: 'android/3.0.0' })

    await expect(res.json()).resolves.toMatchObject({
      clientPolicy: { platform: 'android', writesEnabled: true }
    })
  })

  // crdt.test.ts drives these paths through a positional double, which cannot
  // catch a wrong column list or bind order. Note BODIES are the payload most
  // likely to need a targeted mobile rollback, so their attribution is proven
  // against the real schema here.
  it('stamps attribution on CRDT updates and snapshots', async () => {
    const app = buildApp()
    const update = Buffer.from([1, 2, 3]).toString('base64')

    const updateRes = await request(app, '/sync/crdt/updates', {
      method: 'POST',
      clientHeader: 'ios/1.4.2+91',
      body: JSON.stringify({ noteId: 'note_1', updates: [update] })
    })
    expect(updateRes.status).toBe(200)

    // Read the update row BEFORE the snapshot: a snapshot push prunes the
    // updates it subsumes, so asserting afterwards finds nothing.
    const updateRow = harness.raw
      .prepare('SELECT client_platform, client_version FROM crdt_updates WHERE note_id = ?')
      .get('note_1') as Record<string, unknown> | undefined
    expect(updateRow).toMatchObject({ client_platform: 'ios', client_version: '1.4.2' })

    const snapshotRes = await request(app, '/sync/crdt/snapshot', {
      method: 'POST',
      clientHeader: 'ios/1.4.2+91',
      body: JSON.stringify({ noteId: 'note_1', snapshot: update })
    })
    expect(snapshotRes.status).toBe(200)

    const snapshotRow = harness.raw
      .prepare('SELECT client_platform, client_version FROM crdt_snapshots WHERE note_id = ?')
      .get('note_1') as Record<string, unknown> | undefined
    expect(snapshotRow).toMatchObject({ client_platform: 'ios', client_version: '1.4.2' })
  })

  it('leaves CRDT attribution NULL for a header-less client', async () => {
    const app = buildApp()
    const res = await request(app, '/sync/crdt/updates', {
      method: 'POST',
      body: JSON.stringify({ noteId: 'note_2', updates: [Buffer.from([9]).toString('base64')] })
    })

    expect(res.status).toBe(200)
    const row = harness.raw
      .prepare('SELECT client_platform, client_version FROM crdt_updates WHERE note_id = ?')
      .get('note_2') as Record<string, unknown> | undefined
    expect(row).toMatchObject({ client_platform: null, client_version: null })
  })

  it('falls back to legacy behaviour when the header is malformed', async () => {
    setPolicy('ios', { writesEnabled: 0 })

    const app = buildApp()
    const res = await request(app, '/sync/push', {
      method: 'POST',
      clientHeader: 'ios-1.0.0',
      body: JSON.stringify({ items: [await pushItem('task-9')] })
    })

    expect(res.status).toBe(200)
    expect(itemRow('task-9')?.client_platform).toBeNull()
  })
})
