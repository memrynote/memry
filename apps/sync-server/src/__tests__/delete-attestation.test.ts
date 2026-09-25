import { Hono } from 'hono'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createMemoryR2, createSqliteD1, type SqliteD1 } from './d1-sqlite'
import { encodeSignaturePayload } from '../lib/cbor'
import { errorHandler } from '../lib/errors'
import { cleanupExpiredTombstones } from '../services/cleanup'
import type { AppContext, Bindings } from '../types'
import { deleteAttestationPayload, type DeleteClaim } from '@memry/contracts/delete-attestation'
import { RECORD_SYNC_ITEM_TYPES, type RecordSyncItemType } from '@memry/contracts/sync-api'

/**
 * #2408: the deleting device's content-free delete attestation (protocol 04
 * §4.8.4). The server verifies it per item, stores it, keeps it through the
 * #2302 shed, and serves it on the purged tombstone. Real routes, services,
 * SQL and schema; only auth is stubbed.
 */

const USER_ID = 'user-attest'
const DEVICE_ID = 'device-attest'
const VAULT_ID = 'default'
const DAY = 86_400

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
let attackerKey: CryptoKey

const now = () => Math.floor(Date.now() / 1000)
const b64 = (length: number, fill: number) => Buffer.alloc(length, fill).toString('base64')
const toB64 = (bytes: ArrayBuffer) => Buffer.from(bytes).toString('base64')

const generateKey = async () =>
  (await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify'])) as CryptoKeyPair

const seed = async (): Promise<void> => {
  const keyPair = await generateKey()
  signingKey = keyPair.privateKey
  attackerKey = (await generateKey()).privateKey
  const publicKey = toB64(
    await (crypto.subtle.exportKey as (format: string, key: CryptoKey) => Promise<ArrayBuffer>)(
      'raw',
      keyPair.publicKey
    )
  )
  harness.raw
    .prepare(
      `INSERT INTO users (id, email, email_verified, auth_method, storage_used, storage_limit, created_at, updated_at)
       VALUES (?, ?, 1, 'otp', 0, 0, ?, ?)`
    )
    .run(USER_ID, 'attest@example.com', now(), now())
  harness.raw
    .prepare(
      `INSERT INTO sync_entitlements (user_id, plan, status, source, storage_limit, max_file_size, max_vaults, version_history_days, updated_at)
       VALUES (?, 'plus', 'active', 'paddle', ?, ?, NULL, 30, ?)`
    )
    .run(USER_ID, 50 * 1024 * 1024 * 1024, 100 * 1024 * 1024, now())
  harness.raw
    .prepare(
      `INSERT INTO devices (id, user_id, name, platform, app_version, auth_public_key, created_at, updated_at)
       VALUES (?, ?, 'Attest desktop', 'desktop', '1.0.0', ?, ?, ?)`
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

const sign = async (key: CryptoKey, bytes: Uint8Array) =>
  toB64(await crypto.subtle.sign('Ed25519', key, bytes as unknown as ArrayBuffer))

const attest = (claim: DeleteClaim, key: CryptoKey = signingKey) =>
  sign(key, encodeSignaturePayload(deleteAttestationPayload(claim), 'DELETE_ATTESTATION'))

interface PushSpec {
  id: string
  type?: RecordSyncItemType
  operation?: 'create' | 'update' | 'delete'
  clock?: Record<string, number>
  deletedAt?: number
  /** A string is sent as is; `true` attests the item's own claim with the device key. */
  deleteAttestation?: string | true
}

const signedItem = async (spec: PushSpec) => {
  const { id, type = 'task', clock, deletedAt } = spec
  const operation = spec.operation ?? (deletedAt === undefined ? 'update' : 'delete')
  const base = {
    id,
    type,
    operation,
    cryptoVersion: 1,
    encryptedKey: b64(48, 0x11),
    keyNonce: b64(24, 0x22),
    encryptedData: Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString('base64'),
    dataNonce: b64(24, 0x44),
    ...(clock ? { metadata: { clock } } : {}),
    ...(deletedAt === undefined ? {} : { deletedAt })
  }
  const signature = await sign(signingKey, encodeSignaturePayload(base, 'SYNC_ITEM'))
  const deleteAttestation =
    spec.deleteAttestation === true
      ? await attest({
          id,
          type: type as DeleteClaim['type'],
          clock: clock!,
          deletedAt: deletedAt!
        })
      : spec.deleteAttestation
  const { metadata: _metadata, cryptoVersion: _cryptoVersion, ...wire } = base
  return {
    ...wire,
    ...(clock ? { clock } : {}),
    signature,
    signerDeviceId: DEVICE_ID,
    ...(deleteAttestation === undefined ? {} : { deleteAttestation })
  }
}

const request = (app: App, path: string, init: RequestInit = {}) =>
  app.request(
    path,
    {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init.headers as Record<string, string>) }
    },
    env as unknown as Record<string, unknown>,
    {
      waitUntil: () => undefined,
      passThroughOnException: () => undefined
    } as unknown as ExecutionContext
  )

interface PushBody {
  accepted: string[]
  rejected: Array<{ id: string; reason: string }>
}

const push = async (app: App, specs: PushSpec[]) => {
  const items = await Promise.all(specs.map(signedItem))
  const res = await request(app, '/sync/push', { method: 'POST', body: JSON.stringify({ items }) })
  return { status: res.status, body: (await res.json()) as PushBody }
}

const DECLARING = {
  'X-Memry-Sync-Types': [...RECORD_SYNC_ITEM_TYPES, 'purged_tombstones'].join(',')
}

const pull = async (app: App, itemIds: string[]) => {
  const res = await request(app, '/sync/pull', {
    method: 'POST',
    headers: DECLARING,
    body: JSON.stringify({ itemIds })
  })
  return (await res.json()) as {
    items: unknown[]
    purgedTombstones?: Array<Record<string, unknown>>
  }
}

const stored = (itemId: string) =>
  harness.raw
    .prepare(
      `SELECT blob_key, signer_device_id, delete_attestation, deleted_at, clock
       FROM sync_items WHERE user_id = ? AND item_id = ?`
    )
    .get(USER_ID, itemId) as {
    blob_key: string
    signer_device_id: string | null
    delete_attestation: string | null
    deleted_at: number | null
    clock: string | null
  }

/** Creates task-t, then deletes it with `deleteAttestation`; returns the pushed delete's claim. */
const deleteTask = async (app: App, deleteAttestation?: string | true) => {
  await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
  const claim: DeleteClaim = {
    id: 'task-t',
    type: 'task',
    clock: { [DEVICE_ID]: 2 },
    deletedAt: now() - 31 * DAY
  }
  const res = await push(app, [
    { id: 'task-t', clock: claim.clock, deletedAt: claim.deletedAt, deleteAttestation }
  ])
  return { claim, res }
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
  vi.restoreAllMocks()
})

describe('delete attestations on push, shed and pull (#2408)', () => {
  // #2408
  it('stores a valid attestation, keeps it through the shed, and serves it with the signer', async () => {
    const app = buildApp()
    const { claim, res } = await deleteTask(app, true)
    expect(res.body.accepted).toEqual(['task-t'])
    const attestation = stored('task-t').delete_attestation
    expect(attestation).toEqual(expect.any(String))

    expect(await cleanupExpiredTombstones(harness.db, storage)).toBe(1)

    expect(stored('task-t')).toMatchObject({
      blob_key: '',
      signer_device_id: DEVICE_ID,
      delete_attestation: attestation
    })
    expect((await pull(app, ['task-t'])).purgedTombstones).toEqual([
      {
        id: 'task-t',
        type: 'task',
        deletedAt: claim.deletedAt,
        clock: claim.clock,
        serverCursor: expect.any(Number),
        signerDeviceId: DEVICE_ID,
        deleteAttestation: attestation
      }
    ])
  })

  // #2408: the shed's crash window (blob gone, row not yet marked) serves it too.
  it('serves the attestation on a tombstone whose blob is gone before it is marked', async () => {
    const app = buildApp()
    await deleteTask(app, true)
    await storage.delete(stored('task-t').blob_key)

    const [entry] = (await pull(app, ['task-t'])).purgedTombstones ?? []

    expect(entry).toMatchObject({
      signerDeviceId: DEVICE_ID,
      deleteAttestation: stored('task-t').delete_attestation
    })
  })

  // #2408: a bad attestation costs its own item, never the request (§5.4, #2320).
  it.each([
    ['signed by another key', 'forged'],
    ['not base64', '%%%'],
    ['the wrong length', Buffer.alloc(12, 1).toString('base64')]
  ])(
    'rejects an attestation %s with SYNC_INVALID_SIGNATURE per item, HTTP 200, neighbours accepted',
    async (_label, kind) => {
      const app = buildApp()
      await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
      const claim: DeleteClaim = {
        id: 'task-t',
        type: 'task',
        clock: { [DEVICE_ID]: 2 },
        deletedAt: now()
      }
      const attestation = kind === 'forged' ? await attest(claim, attackerKey) : kind

      const res = await push(app, [
        {
          id: 'task-t',
          clock: claim.clock,
          deletedAt: claim.deletedAt,
          deleteAttestation: attestation
        },
        { id: 'task-ok', clock: { [DEVICE_ID]: 1 } }
      ])

      expect(res.status).toBe(200)
      expect(res.body.accepted).toEqual(['task-ok'])
      expect(res.body.rejected).toEqual([{ id: 'task-t', reason: 'SYNC_INVALID_SIGNATURE' }])
      expect(stored('task-t')).toMatchObject({ deleted_at: null, delete_attestation: null })
    }
  )

  // #2408: an attestation over a different claim than the pushed one is a forgery.
  it('rejects an attestation over another clock than the pushed one', async () => {
    const app = buildApp()
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 1 } }])
    const deletedAt = now()
    const other = await attest({ id: 'task-t', type: 'task', clock: { x: 2 ** 31 }, deletedAt })

    const res = await push(app, [
      { id: 'task-t', clock: { [DEVICE_ID]: 2 }, deletedAt, deleteAttestation: other }
    ])

    expect(res.body.rejected).toEqual([{ id: 'task-t', reason: 'SYNC_INVALID_SIGNATURE' }])
  })

  // #2408: nothing to attest, so the field is ignored and never stored.
  it('ignores an attestation on an update, a clock-free type, or a delete without deletedAt', async () => {
    const app = buildApp()
    const res = await push(app, [
      { id: 'task-u', clock: { [DEVICE_ID]: 1 }, deleteAttestation: 'garbage' },
      { id: 'general', type: 'settings', deletedAt: now(), deleteAttestation: 'garbage' },
      {
        id: 'task-n',
        operation: 'delete',
        clock: { [DEVICE_ID]: 1 },
        deleteAttestation: 'garbage'
      }
    ])

    expect(res.status).toBe(200)
    expect(res.body.rejected).toEqual([])
    for (const id of ['task-u', 'general', 'task-n']) {
      expect(stored(id).delete_attestation).toBeNull()
    }
  })

  // #2408 compat: an old client's delete has no attestation; its marker is served without one.
  it('accepts an old-client delete with NULL stored and serves its marker unattested', async () => {
    const app = buildApp()
    const { res } = await deleteTask(app)
    expect(res.body.accepted).toEqual(['task-t'])
    expect(stored('task-t').delete_attestation).toBeNull()
    await cleanupExpiredTombstones(harness.db, storage)

    const [entry] = (await pull(app, ['task-t'])).purgedTombstones ?? []

    expect(entry).toBeDefined()
    expect(entry).not.toHaveProperty('signerDeviceId')
    expect(entry).not.toHaveProperty('deleteAttestation')
  })

  // #2408: a marker whose attestation column is set but whose signer is gone is unattested.
  it('serves no attestation fields when the signer column is empty', async () => {
    const app = buildApp()
    await deleteTask(app, true)
    await cleanupExpiredTombstones(harness.db, storage)
    harness.raw
      .prepare('UPDATE sync_items SET signer_device_id = NULL WHERE item_id = ?')
      .run('task-t')

    const [entry] = (await pull(app, ['task-t'])).purgedTombstones ?? []

    expect(entry).not.toHaveProperty('signerDeviceId')
    expect(entry).not.toHaveProperty('deleteAttestation')
  })

  // #2408: the column describes the row's current write, so any later accepted write clears it.
  it('clears the attestation on a later accepted non-attested write', async () => {
    const app = buildApp()
    await deleteTask(app, true)
    expect(stored('task-t').delete_attestation).not.toBeNull()

    const res = await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 3 } }])

    expect(res.body.accepted).toEqual(['task-t'])
    expect(stored('task-t')).toMatchObject({ deleted_at: null, delete_attestation: null })
  })

  // #2408: the stored delete_attestation is exactly the one the accepted push carried.
  it('replaces an older attestation on a re-delete', async () => {
    const app = buildApp()
    await deleteTask(app, true)
    const first = stored('task-t').delete_attestation
    const deletedAt = now()
    await push(app, [{ id: 'task-t', clock: { [DEVICE_ID]: 3 } }])
    await push(app, [
      { id: 'task-t', clock: { [DEVICE_ID]: 4 }, deletedAt, deleteAttestation: true }
    ])

    expect(stored('task-t').delete_attestation).not.toBeNull()
    expect(stored('task-t').delete_attestation).not.toBe(first)
  })
})
