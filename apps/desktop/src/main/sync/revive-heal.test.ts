import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import { NetworkError, RateLimitError, SyncServerError } from '@memry/sync-client/http-errors'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb } from '../../test/helpers/test-data-db'
import { getFromServer, type CrdtSnapshotMeta, type CrdtSnapshotResponse } from './http-client'
import {
  createServerBodyReader,
  endsTheRun,
  runReviveHeal,
  type ReviveHealDeps
} from './revive-heal'

vi.mock('./http-client', () => ({ getFromServer: vi.fn() }))
vi.mock('./crdt-encrypt', () => ({ decryptCrdtUpdate: (packed: Uint8Array) => packed }))

const DAY = 'j2099-06-15'

/**
 * The author on a build before #5358: the day written and pushed (server
 * seq 1), deleted with its doc kept, and written again on that doc (seq 2).
 * The server purged seq 1 with the delete.
 */
function shippedRevive(): { author: Y.Doc; purged: Uint8Array; revived: Uint8Array } {
  const author = new Y.Doc()
  author.getText('body').insert(0, 'Deleted words.')
  const purged = Y.encodeStateAsUpdate(author)
  const before = Y.encodeStateVector(author)
  author.getText('body').insert(14, ' Back again.')
  return { author, purged, revived: Y.encodeStateAsUpdate(author, before) }
}

function freshDevice(updates: Uint8Array[]): { text: string; pending: boolean } {
  const doc = new Y.Doc()
  for (const update of updates) Y.applyUpdate(doc, update)
  return {
    text: doc.getText('body').toJSON(),
    pending: doc.store.pendingStructs !== null || doc.store.pendingDs !== null
  }
}

describe('runReviveHeal', () => {
  let db: DrizzleDb
  let queued: Uint8Array[]
  let deps: ReviveHealDeps
  let shipped: ReturnType<typeof shippedRevive>

  beforeEach(() => {
    db = createTestDataDb()
    recordTombstoneClock(db, 'journal', DAY, { 'device-b': 2 })
    shipped = shippedRevive()
    queued = []
    deps = {
      db,
      isNoteSyncable: () => true,
      hasQueuedChange: () => false,
      readServerBody: vi.fn(async () => [shipped.revived]),
      readLocalState: async () => Y.encodeStateAsUpdate(shipped.author),
      enqueueFullState: () => queued.push(Y.encodeStateAsUpdate(shipped.author))
    }
  })

  it('re-pushes the full state of a day the server holds pending, once', async () => {
    expect(freshDevice([shipped.revived])).toEqual({ text: '', pending: true })

    expect(await runReviveHeal(deps)).toBe(1)
    const healed = freshDevice([shipped.revived, ...queued])
    expect(healed.pending).toBe(false)
    // Accepted (#5354): the deleted text returns beside the new text.
    expect(healed.text).toBe('Deleted words. Back again.')

    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).toHaveBeenCalledTimes(1)
    expect(queued).toHaveLength(1)
  })

  it('pushes nothing when the server body integrates on its own', async () => {
    deps.readServerBody = vi.fn(async () => [shipped.purged, shipped.revived])
    expect(await runReviveHeal(deps)).toBe(0)
    expect(queued).toHaveLength(0)
  })

  it('waits for a queued change to be pushed before reading the server', async () => {
    deps.hasQueuedChange = () => true
    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).not.toHaveBeenCalled()
  })

  it('pushes nothing when the local state cannot complete the server body', async () => {
    deps.readLocalState = async () => null
    expect(await runReviveHeal(deps)).toBe(0)
    expect(queued).toHaveLength(0)
  })

  it('retries a note whose local state could not be read, and judges nothing from the failure', async () => {
    deps.readLocalState = vi
      .fn()
      .mockRejectedValueOnce(new Error('provider torn down'))
      .mockResolvedValue(Y.encodeStateAsUpdate(shipped.author))
    expect(await runReviveHeal(deps)).toBe(0)
    expect(await runReviveHeal(deps)).toBe(1)
    expect(queued).toHaveLength(1)
  })

  it('pushes and marks nothing once the run is aborted', async () => {
    const controller = new AbortController()
    deps.readServerBody = vi.fn(async () => {
      controller.abort()
      return [shipped.revived]
    })
    expect(await runReviveHeal(deps, controller.signal)).toBe(0)
    expect(queued).toHaveLength(0)
    deps.readServerBody = vi.fn(async () => [shipped.revived])
    expect(await runReviveHeal(deps)).toBe(1)
  })

  it('reads the notes left out of a run of no verdicts on the next run', async () => {
    for (let day = 1; day <= 50; day++) {
      recordTombstoneClock(db, 'journal', `j2000-01-${String(day).padStart(2, '0')}`, { b: 1 })
    }
    // 51 candidates; DAY sorts last.
    deps.readServerBody = vi.fn(async (noteId: string) =>
      noteId === DAY ? [shipped.revived] : null
    )
    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).not.toHaveBeenCalledWith(DAY)
    expect(await runReviveHeal(deps)).toBe(1)
  })

  it('ends the run on a 429', async () => {
    recordTombstoneClock(db, 'journal', 'j2099-06-16', { 'device-b': 2 })
    deps.readServerBody = vi.fn(async () => {
      throw new RateLimitError(30)
    })
    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['a 429', new RateLimitError(30), true],
    ['no network', new NetworkError('offline'), true],
    ['a 401', new SyncServerError('unauthorized', 401), true],
    ['a 403', new SyncServerError('forbidden', 403), true],
    ['a 500', new SyncServerError('server error', 500), false]
  ])('ends the run on %s: %s', (_label, error, ends) => {
    expect(endsTheRun(error)).toBe(ends)
  })

  it('marks an undecodable body unhealable and heals the next note in the same run', async () => {
    const BROKEN = 'j2099-06-14'
    recordTombstoneClock(db, 'journal', BROKEN, { 'device-b': 2 })
    deps.readServerBody = vi.fn(async (noteId: string) =>
      noteId === BROKEN ? [new Uint8Array([200, 1, 7, 255, 255, 255, 255, 3])] : [shipped.revived]
    )
    expect(await runReviveHeal(deps)).toBe(1)
    expect(await runReviveHeal(deps)).toBe(0)
    expect(deps.readServerBody).toHaveBeenCalledTimes(2)
  })
})

describe('createServerBodyReader', () => {
  const read = createServerBodyReader({
    getAccessToken: async () => 'token',
    getVaultKey: async () => new Uint8Array(32),
    getDevicePublicKey: async () => new Uint8Array(32)
  })
  const update = Buffer.from([1, 2, 3]).toString('base64')
  interface Page {
    updates: Array<{ sequenceNum: number; data: string; signerDeviceId: string }>
    hasMore: boolean
    snapshotMeta: CrdtSnapshotMeta | null
  }
  const serve = (snapshot: CrdtSnapshotResponse, page: Page): void => {
    vi.mocked(getFromServer).mockImplementation(async (path: string) =>
      path.startsWith('/sync/crdt/snapshot/') ? snapshot : page
    )
  }

  it('reads the snapshot and the updates above it', async () => {
    serve(
      { snapshot: update, sequenceNum: 4, signerDeviceId: 'b', revision: 'r1' },
      {
        updates: [{ sequenceNum: 5, data: update, signerDeviceId: 'b' }],
        hasMore: false,
        snapshotMeta: { sequenceNum: 4, revision: 'r1', signerDeviceId: 'b' }
      }
    )
    expect(await read(DAY)).toHaveLength(2)
  })

  it('gives no body when a snapshot lands between the reads', async () => {
    serve(
      { snapshot: null, sequenceNum: 0, signerDeviceId: null },
      {
        updates: [{ sequenceNum: 5, data: update, signerDeviceId: 'b' }],
        hasMore: false,
        snapshotMeta: { sequenceNum: 4, revision: 'r1', signerDeviceId: 'b' }
      }
    )
    expect(await read(DAY)).toBeNull()
  })

  it('gives no body for a snapshot without a signer', async () => {
    serve(
      { snapshot: update, sequenceNum: 4, signerDeviceId: null, revision: 'r1' },
      {
        updates: [],
        hasMore: false,
        snapshotMeta: { sequenceNum: 4, revision: 'r1', signerDeviceId: 'b' }
      }
    )
    expect(await read(DAY)).toBeNull()
  })
})
