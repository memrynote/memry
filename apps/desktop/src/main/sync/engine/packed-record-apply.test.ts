import { afterEach, describe, expect, it, vi } from 'vitest'
import { SyncEngine } from '../engine'
import { SYNC_STATE_KEYS } from './sync-context'
import { ItemApplier } from '../apply-item'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { SyncServerError } from '@memry/sync-client/http-errors'
import type { PackedRecords } from '../packs/record-packs'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-packed-records-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #5390: a fresh device's record packs go through the pull's own apply path,
 * and LAST_CURSOR moves to the tail start only after every item the packs do
 * not hold was pulled by id (protocol 08 §8.10, Closing checks).
 */

type ItemType = 'task' | 'note'

const pullItem = (id: string, type: ItemType = 'task') => ({
  id,
  type,
  operation: 'update' as const,
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: { 'device-2': 1 }
})

const packedRecords = (over: Partial<PackedRecords> = {}): PackedRecords => ({
  apply: [{ item: pullItem('task-packed'), sortKey: 5 }],
  pullById: [{ id: 'task-stale', type: 'task', serverCursor: 8 }],
  tailStart: 10,
  settledBodies: new Set(),
  ...over
})

const emptyFeed = { items: [], deleted: [], hasMore: false, nextCursor: 12 }

type PullFault = 'none' | 'rejected' | 'cancelled'

const serve = async (engine: SyncEngine, fault: PullFault = 'none') => {
  const http = await import('../http-client')
  const cursorAtPull: Array<string | null | undefined> = []
  const getSpy = vi.spyOn(http, 'getFromServer').mockResolvedValue(emptyFeed)
  const postSpy = vi.spyOn(http, 'postToServer').mockImplementation(async (path, body) => {
    if (path !== '/sync/pull') return {}
    cursorAtPull.push(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? null)
    if (fault === 'rejected') throw new SyncServerError('bad request', 400)
    if (fault === 'cancelled') {
      engine.requestCancel()
      throw new DOMException('The operation was aborted.', 'AbortError')
    }
    const { itemIds } = body as { itemIds: string[] }
    return { items: itemIds.map((id) => pullItem(id)) }
  })
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
    content: new TextEncoder().encode(JSON.stringify({ title: 'from B' })),
    verified: true
  })
  return { getSpy, postSpy, cursorAtPull }
}

type Server = Awaited<ReturnType<typeof serve>>

const changesPaths = (getSpy: Server['getSpy']): string[] =>
  getSpy.mock.calls.map(([path]) => path).filter((path) => path.startsWith('/sync/changes'))

describe('PullCoordinator with record packs (#5390)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('applies the packs, pulls the rest by id before any cursor, then tails from the tail start', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const server = await serve(engine)
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(engine.pull([], packedRecords())).resolves.toEqual({ status: 'delivered' })

    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual([
      'task-packed',
      'task-stale'
    ])
    expect(server.postSpy).toHaveBeenCalledWith(
      '/sync/pull',
      { itemIds: ['task-stale'] },
      expect.any(String)
    )
    expect(server.cursorAtPull).toEqual([null])
    expect(changesPaths(server.getSpy)).toEqual(['/sync/changes?limit=500&cursor=10&inline=1'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('12')
  })

  it('sets no cursor when the run stops in the by-id pull, and a rerun redoes every item', async () => {
    const db = getDb()
    const cancelled = new SyncEngine(createMockDeps(db))
    const stopped = await serve(cancelled, 'cancelled')
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(cancelled.pull([], packedRecords())).resolves.toEqual({ status: 'incomplete' })

    expect(stopped.cursorAtPull).toEqual([null])
    expect(changesPaths(stopped.getSpy)).toEqual([])
    expect(cancelled.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR) ?? null).toBeNull()

    vi.restoreAllMocks()
    const engine = new SyncEngine(createMockDeps(db))
    const server = await serve(engine)
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('skipped')

    await expect(engine.pull([], packedRecords())).resolves.toEqual({ status: 'delivered' })

    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual([
      'task-packed',
      'task-stale'
    ])
    expect(changesPaths(server.getSpy)).toEqual(['/sync/changes?limit=500&cursor=10&inline=1'])
  })

  it('starts the tail below an item the by-id pull did not deliver', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const server = await serve(engine, 'rejected')
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await engine.pull([], packedRecords())

    expect(server.cursorAtPull).toEqual([null])
    expect(changesPaths(server.getSpy)).toEqual(['/sync/changes?limit=500&cursor=7&inline=1'])
  })

  it('starts the tail below a packed entry that did not apply', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const server = await serve(engine)
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation((input) => {
      if (input.itemId === 'task-packed') throw new Error('disk full')
      return 'applied'
    })

    await engine.pull([], packedRecords())

    expect(changesPaths(server.getSpy)).toEqual(['/sync/changes?limit=500&cursor=4&inline=1'])
  })

  it('ignores the packs on a device that already has a cursor', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    const server = await serve(engine)
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '7')

    await engine.pull([], packedRecords())

    expect(applySpy).not.toHaveBeenCalled()
    expect(server.postSpy).not.toHaveBeenCalledWith(
      '/sync/pull',
      expect.anything(),
      expect.anything()
    )
    expect(changesPaths(server.getSpy)).toEqual(['/sync/changes?limit=500&cursor=7&inline=1'])
  })

  it('owes no body pull for a note the packs settled', async () => {
    const engine = new SyncEngine(createMockDeps(getDb(), { crdtProvider: {} as never }))
    await serve(engine)
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')
    const owed = vi.spyOn(CrdtSyncCoordinator.prototype, 'oweRecordBody')
    vi.spyOn(CrdtSyncCoordinator.prototype, 'pullCrdtForNotes').mockResolvedValue({
      snapshotGets: 0,
      batchPosts: 0
    })

    await engine.pull(
      [],
      packedRecords({
        apply: [
          { item: pullItem('note-settled', 'note'), sortKey: 3 },
          { item: pullItem('note-behind', 'note'), sortKey: 4 }
        ],
        pullById: [],
        settledBodies: new Set(['note-settled'])
      })
    )

    expect(new Set(owed.mock.calls.map(([id]) => id))).toEqual(new Set(['note-behind']))
  })
})
