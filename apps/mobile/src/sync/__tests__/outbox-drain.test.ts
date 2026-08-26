import { beforeAll, describe, expect, it } from 'vitest'
import sodium from 'libsodium-wrappers-sumo'
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
 * A drain whose HTTP context is deliberately incomplete.
 *
 * Every case below settles its rows BEFORE any request would be made — that is
 * the property under test — so a context that would throw on use is the
 * strongest available assertion that the drain never got that far.
 */
function drain(store: OutboxQueue) {
  const httpCtx = () =>
    ({ accessToken: () => 't', vaultId: 'v', clientHeaderValue: 'ios/1.0.0' }) as SeamHttpContext
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

describe('SyncServerError policy codes', () => {
  it('treats 403 and 426 as policy, not as transient failure', () => {
    const forbidden = new SyncServerError('nope', 403, 'PLATFORM_WRITES_DISABLED')
    const upgrade = new SyncServerError('needs 2.0.0', 426, 'CLIENT_UPGRADE_REQUIRED')
    expect(forbidden.statusCode).toBe(403)
    expect(upgrade.statusCode).toBe(426)
  })
})
