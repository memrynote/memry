import { afterEach, describe, expect, it, vi } from 'vitest'
import { SavedFiltersChannels } from '@memry/contracts/ipc-channels'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SyncEngine, type SyncEngineDeps } from '../engine'
import { CorruptItemTracker } from './corrupt-item-tracker'
import { CrdtSyncCoordinator } from './crdt-sync-coordinator'
import { listCrdtBodyDebts } from './crdt-body-debts'
import { SYNC_STATE_KEYS } from './sync-context'
import { ItemApplier } from '../apply-item'
import * as bulkApply from '../bulk-apply'
import { createMockDeps, setupTestDb } from '@tests/utils/engine-mocks'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-pull-cursor-tx-test' }
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2294: LAST_CURSOR is written inside the transaction of a page's LAST slice,
 * and a window hears about an applied row only after its slice committed.
 */

const CLOCK = { 'device-2': 1 }
const ids = (from: number, to: number): string[] =>
  Array.from({ length: to - from }, (_, i) => `filter-${from + i}`)

const pullItem = (id: string) => ({
  id,
  type: 'filter',
  operation: 'update',
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: CLOCK
})

/** A 500-ref page of filters: five 100-id slices. */
async function mockFilterPage(
  opts: { failSlice?: (itemIds: string[]) => Error | null } = {}
): Promise<ReturnType<typeof vi.spyOn>> {
  const http = await import('../http-client')
  vi.spyOn(http, 'getFromServer').mockResolvedValue({
    items: ids(0, 500).map((id) => ({ id, type: 'filter', version: 1, modifiedAt: 1, size: 10 })),
    deleted: [],
    hasMore: false,
    nextCursor: 500
  })
  const postSpy = vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => {
    const itemIds = (body as { itemIds: string[] }).itemIds
    const failure = opts.failSlice?.(itemIds)
    if (failure) throw failure
    return { items: itemIds.map(pullItem) }
  })
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation((input) => ({
    // What the pushing device's buildPushPayload produced for this row.
    content: new TextEncoder().encode(
      JSON.stringify({
        name: input.id,
        config: {},
        position: 0,
        clock: CLOCK,
        createdAt: '2026-09-01T00:00:00.000Z'
      })
    ),
    verified: true
  }))
  return postSpy
}

const FILTER_EVENTS = new Set<unknown>(Object.values(SavedFiltersChannels.events))
const filterEvents = (emit: unknown): string[] =>
  (emit as ReturnType<typeof vi.fn>).mock.calls
    .filter(([channel]) => FILTER_EVENTS.has(channel))
    .map(([, data]) => (data as { id: string }).id)

/** Records LAST_CURSOR (and the durable CRDT debts) as each slice commit starts. */
function recordAtCommit(
  engine: SyncEngine,
  opts: { untransacted?: boolean } = {}
): Array<{ cursor?: string; debts?: number }> {
  const seen: Array<{ cursor?: string; debts?: number }> = []
  const begin = bulkApply.beginPageApply
  vi.spyOn(bulkApply, 'beginPageApply').mockImplementation((db) => {
    const handle = begin(db)
    if (opts.untransacted) Object.defineProperty(handle, 'transacted', { value: false })
    const commit = handle.commit.bind(handle)
    handle.commit = () => {
      seen.push({
        cursor: engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR),
        debts: listCrdtBodyDebts(engine['ctx'].deps.db).length
      })
      commit()
    }
    return handle
  })
  return seen
}

const itemSyncedEvents = (emit: unknown): string[] =>
  (emit as ReturnType<typeof vi.fn>).mock.calls
    .filter(([channel]) => channel === EVENT_CHANNELS.ITEM_SYNCED)
    .map(([, data]) => (data as { itemId: string }).itemId)

describe('PullCoordinator cursor inside the last slice transaction (#2294)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // #2294
  it('a crash between slice 3 and 4 holds the cursor, and the re-pull re-applies only slices 4-5', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    const { SyncServerError } = await import('../http-client')
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')

    await mockFilterPage({
      failSlice: (itemIds) =>
        itemIds.includes('filter-300') ? new SyncServerError('crash', 400, 'crash') : null
    })
    await expect(engine.pull()).resolves.toBe(false)

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
    expect(filterEvents(deps.emitToRenderer)).toHaveLength(300)

    vi.restoreAllMocks()
    ;(deps.emitToRenderer as ReturnType<typeof vi.fn>).mockClear()
    const postSpy = await mockFilterPage()
    await expect(engine.pull()).resolves.toBe(true)

    expect(postSpy).toHaveBeenCalledTimes(5)
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
    expect(filterEvents(deps.emitToRenderer)).toEqual(ids(300, 500))
    // Skipped re-deliveries changed nothing, so the renderer is not told to refetch.
    expect(itemSyncedEvents(deps.emitToRenderer)).toEqual(ids(300, 500))
  })

  // #2294
  it('only the last slice commit carries the new cursor', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const cursorAtCommit: Array<string | undefined> = []
    const begin = bulkApply.beginPageApply
    vi.spyOn(bulkApply, 'beginPageApply').mockImplementation((db) => {
      const handle = begin(db)
      const commit = handle.commit.bind(handle)
      handle.commit = () => {
        cursorAtCommit.push(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR))
        commit()
      }
      return handle
    })

    await engine.pull()

    expect(cursorAtCommit).toEqual(['0', '0', '0', '0', '500'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  // #2294
  it('a last slice whose commit throws keeps the cursor and emits nothing for its items', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const begin = bulkApply.beginPageApply
    let slice = 0
    vi.spyOn(bulkApply, 'beginPageApply').mockImplementation((db) => {
      const handle = begin(db)
      if (++slice === 5) {
        handle.commit = () => {
          throw new Error('data commit boom')
        }
      }
      return handle
    })

    await engine.pull()

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
    expect(filterEvents(deps.emitToRenderer)).toEqual(ids(0, 400))
    expect(itemSyncedEvents(deps.emitToRenderer)).toEqual(ids(0, 400))
  })

  // #2294: an abort inside the last slice still refuses to move the cursor.
  it('an abort inside the last slice commits its applied rows without the cursor', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const apply = ItemApplier.prototype.apply
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation(function (
      this: ItemApplier,
      ...args
    ) {
      if (args[0].itemId === 'filter-450') engine['ctx'].abortController!.abort()
      return apply.apply(this, args)
    })

    await expect(engine.pull()).resolves.toBe(false)

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
  })

  // #2294: the breaker still advances past a poisoned page.
  it('a breaker on the last slice still advances the cursor with that slice', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
      throw new Error(`decryption failed for ${input.id}`)
    })

    await expect(engine.pull()).resolves.toBe(false)

    expect(engine.currentState).toBe('error')
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  // #2294: a HOLDS_CURSOR stop on the last slice keeps the earlier slices' rows.
  it('an invalid pull response on the last slice holds the cursor', async () => {
    const deps = createMockDeps(getDb())
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const http = await import('../http-client')
    const post = vi.mocked(http.postToServer).getMockImplementation()!
    vi.spyOn(http, 'postToServer').mockImplementation(async (path, body, token) =>
      (body as { itemIds: string[] }).itemIds.includes('filter-400')
        ? { error: 'not a pull envelope' }
        : post(path, body, token)
    )

    await expect(engine.pull()).resolves.toBe(false)

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
    expect(filterEvents(deps.emitToRenderer)).toEqual(ids(0, 400))
  })

  // #2294: a page with no refs has no slice transaction to join.
  it('an empty page still moves the cursor', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    vi.spyOn(await import('../http-client'), 'getFromServer').mockResolvedValue({
      items: [],
      deleted: [],
      hasMore: false,
      nextCursor: 42
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('42')
  })

  // #2294 review: a crash between the last slice's commit and its corrupt
  // re-fetch used to lose a transiently undecryptable update for good.
  it('a last slice with an item awaiting re-fetch keeps the cursor out of its transaction', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const decrypt = await import('../decrypt')
    const decryptOk = vi.mocked(decrypt.decryptItemFromPull).getMockImplementation()!
    vi.spyOn(decrypt, 'decryptItemFromPull').mockImplementation((input) => {
      if (input.id === 'filter-450') throw new Error('decryption failed: truncated read')
      return decryptOk(input)
    })
    const seen = recordAtCommit(engine)
    vi.spyOn(CorruptItemTracker.prototype, 'refetch').mockRejectedValue(new Error('crash'))

    await engine.pull()

    expect(seen.map((c) => c.cursor)).toEqual(['0', '0', '0', '0', '0'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
  })

  // #2294 review: the same page with the re-fetch completing moves the cursor after it.
  it('a last slice with an item awaiting re-fetch moves the cursor once the re-fetch ran', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const decrypt = await import('../decrypt')
    const decryptOk = vi.mocked(decrypt.decryptItemFromPull).getMockImplementation()!
    vi.spyOn(decrypt, 'decryptItemFromPull').mockImplementation((input) => {
      if (input.id === 'filter-450') throw new Error('decryption failed: truncated read')
      return decryptOk(input)
    })
    const refetch = vi.spyOn(CorruptItemTracker.prototype, 'refetch').mockResolvedValue({
      recovered: [],
      permanentFailures: [],
      missing: [],
      invalid: [],
      blobMissing: [],
      skipped: []
    })

    await engine.pull()

    expect(refetch).toHaveBeenCalledOnce()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  // #2294 review: an item deferred for retry keeps the cursor out of the slice.
  it('a page with an apply deferred for retry writes the cursor after the page', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const apply = ItemApplier.prototype.apply
    let thrown = false
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation(function (
      this: ItemApplier,
      ...args
    ) {
      if (args[0].itemId === 'filter-450' && !thrown) {
        thrown = true
        throw new Error('parent not pulled yet')
      }
      return apply.apply(this, args)
    })
    const seen = recordAtCommit(engine)

    await expect(engine.pull()).resolves.toBe(true)

    expect(seen.map((c) => c.cursor)).toEqual(['0', '0', '0', '0', '0'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  // #2294 review: an untransacted page cannot make the cursor atomic with its rows.
  it('an untransacted last slice writes the cursor after the page', async () => {
    const engine = new SyncEngine(createMockDeps(getDb()))
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await mockFilterPage()
    const seen = recordAtCommit(engine, { untransacted: true })

    await engine.pull()

    expect(seen.map((c) => c.cursor)).toEqual(['0', '0', '0', '0', '0'])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('500')
  })

  // #2294 review (B-H1): a crash after the last slice's commit but before its
  // CRDT batch left the notes looking merged with the cursor past them, so a
  // later snapshot push could prune a peer's body updates.
  it('a note page commits its CRDT debt in the slice and keeps the cursor until the CRDT batch ran', async () => {
    const provider = {
      inactiveDocCapacity: 32,
      isNoteLocalOnly: vi.fn(() => false),
      raiseInactiveDocCapacity: vi.fn()
    }
    const engine = new SyncEngine(
      createMockDeps(getDb(), {
        crdtProvider: provider as unknown as SyncEngineDeps['crdtProvider']
      })
    )
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    const noteIds = Array.from({ length: 3 }, (_, i) => `note-${i}`)
    const http = await import('../http-client')
    vi.spyOn(http, 'getFromServer').mockResolvedValue({
      items: noteIds.map((id) => ({ id, type: 'note', version: 1, modifiedAt: 1, size: 10 })),
      deleted: [],
      hasMore: false,
      nextCursor: 3
    })
    vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => ({
      items: (body as { itemIds: string[] }).itemIds.map((id) => ({
        ...pullItem(id),
        type: 'note'
      }))
    }))
    vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
      content: new TextEncoder().encode(JSON.stringify({ title: 'n' })),
      verified: true
    })
    // The row a real apply creates: a queued pull merges only into a note with one.
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation((input) => {
      getDb()
        .db.insert(noteMetadata)
        .values({
          id: input.itemId,
          path: `${input.itemId}.md`,
          title: 'n',
          createdAt: 'x',
          modifiedAt: 'x'
        })
        .run()
      return 'applied'
    })
    const crdtBatch = vi
      .spyOn(CrdtSyncCoordinator.prototype, 'applyCrdtBatch')
      .mockRejectedValue(new Error('crash'))
    const seen = recordAtCommit(engine)

    await engine.pull()

    expect(crdtBatch).toHaveBeenCalledOnce()
    expect(seen).toEqual([{ cursor: '0', debts: 3 }])
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('0')
    expect(listCrdtBodyDebts(engine['ctx'].deps.db)).toHaveLength(3)
  })
})
