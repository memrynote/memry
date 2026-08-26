import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
import type { SyncHttpClient } from '@memry/sync-client/adapters'
import type { SeamHttpContext } from '@memry/sync-client/pull'
import { SyncServerError } from '@memry/sync-client/http-errors'
import { backoffDelayMs, OutboxDrain, type OutboxQueue, type OutboxRow } from '../outbox'
import { applyClientPolicy, getReadOnlyState } from '../read-only-mode'
import { nodeCryptoProvider } from './relay'

/**
 * The drain's failure paths, which are the ones that fail SILENTLY.
 *
 * A row that ends up neither completed nor failed is re-claimed on every pass
 * and wedges every later push behind it — no exception surfaces, the outbox
 * just stops emptying.
 */

let crypto: ReturnType<typeof nodeCryptoProvider>
let vaultKey: Uint8Array
let signingSecretKey: Uint8Array

beforeAll(async () => {
  await sodium.ready
  crypto = nodeCryptoProvider()
  vaultKey = sodium.randombytes_buf(32)
  signingSecretKey = sodium.crypto_sign_keypair('uint8array').privateKey
})

function encode(value: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(value))
}

function row(overrides: Partial<OutboxRow> = {}): OutboxRow {
  return {
    id: 1,
    itemType: 'note:update',
    itemId: 'note-1',
    op: 'upsert',
    payload: new TextEncoder().encode(JSON.stringify({ title: 'A' })),
    attemptCount: 0,
    lastError: null,
    ...overrides
  }
}

function queue(rows: OutboxRow[]) {
  const completed: number[] = []
  const failed: { ids: number[]; error: string }[] = []
  let claimed = false
  const store: OutboxQueue = {
    claimBatch: async () => {
      if (claimed) return []
      claimed = true
      return rows
    },
    complete: async (ids) => {
      completed.push(...ids)
    },
    fail: async (ids, error) => {
      failed.push({ ids, error })
    },
    pendingCount: async () => rows.length - completed.length
  }
  return { store, completed, failed }
}

/**
 * A fake transport at the seam the drain actually uses.
 *
 * `seamJsonRequest` goes through `SyncHttpClient`, so replacing that is enough
 * to exercise the real request-building, the real response parsing and the
 * real accept/reject attribution without a server.
 */
interface FakeResponse {
  status?: number
  payload: unknown
}

function transport(handler: (path: string, body: unknown) => unknown | FakeResponse) {
  const seen: { path: string; body: unknown }[] = []
  const http: SyncHttpClient = {
    async request(req) {
      // `seamJsonRequest` sends a JSON STRING, not bytes.
      const body = typeof req.body === 'string' ? JSON.parse(req.body) : null
      seen.push({ path: req.path, body })
      const answer = handler(req.path, body) as FakeResponse & Record<string, unknown>
      // A STATUS, not a thrown error: `seamJsonRequest` wraps anything the
      // transport throws in a NetworkError, which would make an error-code
      // assertion pass for the wrong reason.
      const status = typeof answer?.status === 'number' ? answer.status : 200
      const payload = 'payload' in (answer ?? {}) ? answer.payload : answer
      return {
        status,
        headers: { 'content-type': 'application/json' },
        body: new TextEncoder().encode(JSON.stringify(payload))
      }
    },
    onOnlineChanged: () => () => {},
    isMetered: async () => false
  }
  return { http, seen }
}

function drain(store: OutboxQueue, http?: SyncHttpClient) {
  const httpCtx = () =>
    ({
      // Cases that settle their rows BEFORE any request pass no transport at
      // all: a context that would throw on use is the strongest available
      // assertion that the drain never got that far.
      http: http as SyncHttpClient,
      accessToken: () => 't',
      vaultId: 'v',
      clientHeaderValue: 'ios/1.0.0'
    }) as SeamHttpContext
  return new OutboxDrain({
    store,
    httpCtx,
    crypto,
    vaultKey: () => vaultKey,
    signingSecretKey: () => signingSecretKey,
    deviceId: () => 'device-a',
    isOnline: () => true
  })
}

describe('backoffDelayMs', () => {
  it('grows and then caps, and never returns the same value twice in a row by construction', () => {
    const first = backoffDelayMs(1)
    const later = backoffDelayMs(4)
    expect(later).toBeGreaterThan(first)
    // Capped: an item that has failed twenty times must not schedule itself
    // hours out, because the user is still looking at an unsynced note.
    expect(backoffDelayMs(50)).toBeLessThanOrEqual(5 * 60_000 + 5_000)
  })
})

describe('OutboxDrain read-only parking', () => {
  it('parks rather than draining, and drops nothing', async () => {
    applyClientPolicy({ platform: 'ios', writesEnabled: false }, '1.0.0')
    expect(getReadOnlyState().readOnly).toBe(true)

    const { store, completed, failed } = queue([row()])
    const result = await drain(store).drain()

    expect(result.parked).toBe(true)
    expect(completed).toHaveLength(0)
    expect(failed).toHaveLength(0)

    // Leave the module-level state clean for the other suites.
    applyClientPolicy({ platform: 'ios', writesEnabled: true }, '1.0.0')
    expect(getReadOnlyState().readOnly).toBe(false)
  })
})

describe('OutboxDrain row-level failures', () => {
  it('retires a row whose payload can never be parsed instead of retrying it forever', async () => {
    const { store, completed, failed } = queue([
      row({ id: 7, payload: new TextEncoder().encode('not json') })
    ])
    await drain(store).drain()

    // Neither completed nor failed would mean this row is re-claimed on every
    // pass and every later record push queues behind it.
    expect(completed).toContain(7)
    expect(failed).toHaveLength(0)
  })
})

describe('OutboxDrain oversized items', () => {
  it('retires an item too large to encrypt instead of wedging the queue behind it', async () => {
    // Larger than SYNC_ITEM_MAX_ENCRYPT_BYTES, so `encryptRecordForPush` throws
    // ItemTooLargeError before any request is attempted. Letting that escape
    // leaves the row neither completed nor failed, and every later record push
    // queues behind it forever.
    const huge = JSON.stringify({ title: 'A', content: 'x'.repeat(12 * 1024 * 1024) })
    const { store, completed, failed } = queue([
      row({ id: 9, payload: new TextEncoder().encode(huge) })
    ])

    await expect(drain(store).drain()).resolves.toBeDefined()
    expect(completed).toContain(9)
    expect(failed).toHaveLength(0)
  })
})

describe('OutboxDrain per-item coalescing', () => {
  it('sends one item per id and settles every row behind it', async () => {
    // Create then rename, both offline: two rows, one item id. The newest
    // row's payload already contains everything the earlier one said.
    const rows = [
      row({ id: 1, itemType: 'note:create', payload: encode({ title: 'Draft' }) }),
      row({ id: 2, itemType: 'note:update', payload: encode({ title: 'Renamed' }) })
    ]
    const { store, completed, failed } = queue(rows)
    const { http, seen } = transport(() => ({
      accepted: ['note-1'],
      rejected: [],
      serverTime: 0,
      maxCursor: 1
    }))

    await drain(store, http).drain()

    const pushBody = seen.find((r) => r.path === '/sync/push')?.body as { items: { id: string }[] }
    // Two items with the same id in one batch cannot be told apart in the
    // per-ID response, which is exactly how a partial accept used to delete
    // the rejected row too.
    expect(pushBody.items).toHaveLength(1)
    expect(completed).toEqual(expect.arrayContaining([1, 2]))
    expect(failed).toHaveLength(0)
  })

  it('lets a delete win over an update queued before it', async () => {
    // Rows are ordered by id, so the tombstone is last and supersedes the
    // update. If the update won instead, the note would be deleted locally and
    // resurrected on every other device — the worst outcome this queue has.
    const rows = [
      row({ id: 10, itemType: 'note:update', payload: encode({ title: 'Renamed' }) }),
      row({ id: 11, itemType: 'note:delete', op: 'delete', payload: encode({ title: 'Renamed' }) })
    ]
    const { store, completed } = queue(rows)
    const { http, seen } = transport(() => ({
      accepted: ['note-1'],
      rejected: [],
      serverTime: 0,
      maxCursor: 1
    }))

    await drain(store, http).drain()

    const items = (
      seen.find((r) => r.path === '/sync/push')?.body as {
        items: { operation: string; deletedAt?: number }[]
      }
    ).items
    expect(items).toHaveLength(1)
    expect(items[0].operation).toBe('delete')
    expect(items[0].deletedAt).toBeTypeOf('number')
    expect(completed).toEqual(expect.arrayContaining([10, 11]))
  })

  it('fails every row behind a rejected item, and completes none of them', async () => {
    const rows = [
      row({ id: 3, itemType: 'note:create', payload: encode({ title: 'Draft' }) }),
      row({ id: 4, itemType: 'note:update', payload: encode({ title: 'Renamed' }) })
    ]
    const { store, completed, failed } = queue(rows)
    const { http } = transport(() => ({
      accepted: [],
      rejected: [{ id: 'note-1', reason: 'conflict' }],
      serverTime: 0,
      maxCursor: 0
    }))

    await drain(store, http).drain()

    expect(completed).toHaveLength(0)
    expect(failed.flatMap((f) => f.ids)).toEqual(expect.arrayContaining([3, 4]))
  })
})

describe('OutboxDrain CRDT chunking', () => {
  it("splits a note's queued updates at the server cap", async () => {
    // The server caps `updates` at 100. One over-sized request is a 400 that
    // repeats on every drain, so that note's body would never sync again.
    const rows = Array.from({ length: 250 }, (_, i) =>
      row({
        id: i + 1,
        itemType: 'note:crdt',
        op: 'crdt-update',
        payload: new Uint8Array([i % 251])
      })
    )
    const { store, completed, failed } = queue(rows)
    const { http, seen } = transport(() => ({ sequences: [] }))

    await drain(store, http).drain()

    const requests = seen.filter((r) => r.path === '/sync/crdt/updates')
    expect(requests).toHaveLength(3)
    for (const request of requests) {
      expect((request.body as { updates: string[] }).updates.length).toBeLessThanOrEqual(100)
    }
    expect(completed).toHaveLength(250)
    expect(failed).toHaveLength(0)
  })
})

describe('OutboxDrain server rejections', () => {
  it('parks on a policy code', async () => {
    const { store, failed } = queue([row({ id: 30 })])
    const { http } = transport(() => ({
      status: 403,
      payload: { error: { code: 'PLATFORM_WRITES_DISABLED', message: 'writes off' } }
    }))

    const result = await drain(store, http).drain()

    expect(result.parked).toBe(true)
    expect(getReadOnlyState().readOnly).toBe(true)
    // Parked rows must not accrue backoff for a condition they did not cause,
    // or the first pass after the switch clears sits idle.
    expect(failed).toHaveLength(0)

    applyClientPolicy({ platform: 'ios', writesEnabled: true }, '1.0.0')
  })

  it('does NOT park on a 403 that is not a policy code', async () => {
    const { store, failed } = queue([row({ id: 20 })])
    // A 403 that is NOT a policy code: a revoked device, a quota refusal.
    // Parking on it sets no read-only state and records no backoff, so the
    // outbox stops draining with no symptom anywhere.
    const { http } = transport(() => ({
      status: 403,
      payload: { error: { code: 'AUTH_DEVICE_REVOKED', message: 'device revoked' } }
    }))

    const result = await drain(store, http).drain()

    expect(result.parked).toBe(false)
    expect(getReadOnlyState().readOnly).toBe(false)
    expect(failed.flatMap((f) => f.ids)).toContain(20)
  })
})
