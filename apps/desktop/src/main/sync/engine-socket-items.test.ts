import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { syncTombstoneClocks } from '@memry/db-schema/schema/sync-tombstone-clocks'
import type { SyncSocketEvent } from '@memry/contracts/sync-socket'
import { SyncEngine } from './engine'
import { SYNC_STATE_KEYS } from './engine/sync-context'
import { ItemApplier } from './apply-item'
import { SignatureVerificationError } from './decrypt'
import { CrdtSyncCoordinator } from './engine/crdt-sync-coordinator'
import { PushCoordinator } from './engine/push-coordinator'
import { listCrdtBodyDebts } from './engine/crdt-body-debts'
import type { SyncEngineDeps } from './engine/sync-context'
import { createMockDeps, createMockWs, setupTestDb } from '@tests/utils/engine-mocks'
import { asSyncDb } from '@tests/utils/test-db'
import { noteMetadata } from '@memry/db-schema/schema/note-metadata'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-engine-socket-items-test' }
}))

vi.mock('../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2300 acceptance: a `changes_available` frame with items applies them before
 * the wake pull has answered, never moves LAST_CURSOR, and the pull that
 * follows re-delivers the same row as an equal-clock identical skip.
 */

const CLOCK = { 'device-2': 1 }

const pullItem = (id: string) => ({
  id,
  type: 'filter' as const,
  operation: 'update' as const,
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: CLOCK
})

const frame = (ids: string[], cursor: number): SyncSocketEvent => ({
  kind: 'changes_available',
  cursor,
  committedAtMs: Date.now(),
  items: ids.map(pullItem)
})

async function mockFilterPayloads(badSignature: Set<string> = new Set()): Promise<void> {
  vi.spyOn(await import('./decrypt'), 'decryptItemFromPull').mockImplementation((input) => {
    if (badSignature.has(input.id)) throw new SignatureVerificationError(input.id, 'device-2')
    return {
      content: new TextEncoder().encode(
        JSON.stringify({
          name: `name of ${input.id}`,
          config: {},
          position: 0,
          clock: CLOCK,
          createdAt: '2026-09-01T00:00:00.000Z'
        })
      ),
      verified: true
    }
  })
}

/** A started engine whose wake pull is parked on its first /sync/changes until released. */
async function startEngineWithHeldPull(
  getDb: Parameters<typeof createMockDeps>[0],
  overrides: Partial<SyncEngineDeps> = {}
): Promise<{
  engine: SyncEngine
  ws: ReturnType<typeof createMockWs>
  changesCalls: () => number
  releaseChanges: (page: unknown) => void
  pullItems: ReturnType<typeof vi.fn>
}> {
  const http = await import('./http-client')
  let release!: (page: unknown) => void
  const held = new Promise((resolve) => {
    release = resolve
  })
  let started = false
  const getSpy = vi.spyOn(http, 'getFromServer').mockImplementation(async () => {
    if (!started) return { items: [], deleted: [], hasMore: false, nextCursor: 0 }
    return held
  })
  const pullItems = vi.fn(async (itemIds: string[]) => ({ items: itemIds.map(pullItem) }))
  vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) =>
    pullItems((body as { itemIds: string[] }).itemIds)
  )

  const ws = createMockWs()
  const engine = new SyncEngine(createMockDeps(getDb, { ws, ...overrides }))
  vi.spyOn(engine, 'fullSync').mockResolvedValue()
  await engine.start()
  engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '4')
  started = true
  const callsAtStart = getSpy.mock.calls.length
  return {
    engine,
    ws,
    changesCalls: () => getSpy.mock.calls.length - callsAtStart,
    releaseChanges: release,
    pullItems
  }
}

describe('SyncEngine socket items (#2300)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  /** The stubbed note apply creates the row: a queued pull merges only into a note with one. */
  const insertNoteRow = (id: string): 'applied' => {
    getDb()
      .db.insert(noteMetadata)
      .values({ id, path: `${id}.md`, title: id, createdAt: 'x', modifiedAt: 'x' })
      .onConflictDoNothing()
      .run()
    return 'applied'
  }

  const filterName = (id: string): string | undefined =>
    getDb().db.select().from(savedFilters).where(eq(savedFilters.id, id)).get()?.name

  // #2300
  it('socket items apply before the wake pull answers and leave LAST_CURSOR alone', async () => {
    await mockFilterPayloads()
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')
    const { engine, ws, changesCalls, releaseChanges, pullItems } =
      await startEngineWithHeldPull(getDb())

    ws.emit('message', frame(['filter-1'], 9))

    await vi.waitFor(() => expect(filterName('filter-1')).toBe('name of filter-1'))
    // The wake pull is parked on its /sync/changes request: nothing it fetched
    // put the row there.
    expect(changesCalls()).toBe(1)
    expect(pullItems).not.toHaveBeenCalled()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')
    expect(applySpy.mock.results.map((r) => r.value)).toEqual(['applied'])

    // The feed re-delivers the same row: an equal-clock identical skip (#2294).
    releaseChanges({
      items: [{ id: 'filter-1', type: 'filter', version: 1, modifiedAt: 1, size: 10 }],
      deleted: [],
      hasMore: false,
      nextCursor: 9
    })
    await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9'))
    expect(pullItems).toHaveBeenCalledWith(['filter-1'])
    expect(applySpy.mock.results.map((r) => r.value)).toEqual(['applied', 'skipped'])

    await engine.stop({ skipFinalPush: true })
  })

  // #2300
  it('a frame item with a bad signature is not applied, and the pull quarantines it', async () => {
    await mockFilterPayloads(new Set(['filter-bad']))
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')
    const { engine, ws, releaseChanges } = await startEngineWithHeldPull(getDb())

    ws.emit('message', frame(['filter-bad', 'filter-ok'], 9))

    await vi.waitFor(() => expect(filterName('filter-ok')).toBe('name of filter-ok'))
    expect(filterName('filter-bad')).toBeUndefined()
    expect(engine.getQuarantinedItems()).toEqual([])

    releaseChanges({
      items: [
        { id: 'filter-bad', type: 'filter', version: 1, modifiedAt: 1, size: 10 },
        { id: 'filter-ok', type: 'filter', version: 1, modifiedAt: 1, size: 10 }
      ],
      deleted: [],
      hasMore: false,
      nextCursor: 9
    })
    await vi.waitFor(() =>
      expect(engine.getQuarantinedItems().map((item) => item.itemId)).toEqual(['filter-bad'])
    )
    expect(filterName('filter-bad')).toBeUndefined()
    expect(applySpy.mock.calls.map(([input]) => input.itemId)).not.toContain('filter-bad')

    await engine.stop({ skipFinalPush: true })
  })

  // #2297 / #2299 restack: a note record applied from a frame owes its whole
  // body exactly as the pull's queueBodyPull does. The durable `record` debt and
  // the unmerged flag exist before the wake pull answers, so no snapshot push
  // can claim past a body this device has not merged. The frame lands no body:
  // the wake pull's re-delivery batches it.
  it('a note record from a frame owes its whole body before the wake pull answers', async () => {
    await mockFilterPayloads()
    const realApply = ItemApplier.prototype.apply
    vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation(function (
      this: ItemApplier,
      input,
      page
    ) {
      return input.type === 'note' ? insertNoteRow(input.itemId) : realApply.call(this, input, page)
    })
    // The pull empties its id list after the batch, so each call is copied.
    const batched: string[][] = []
    const batch = vi
      .spyOn(CrdtSyncCoordinator.prototype, 'applyCrdtBatch')
      .mockImplementation(async (ids) => {
        batched.push([...ids])
        return { snapshotGets: 0, batchPosts: 0 }
      })
    const provider = {
      inactiveDocCapacity: 32,
      isNoteLocalOnly: vi.fn(() => false),
      raiseInactiveDocCapacity: vi.fn()
    }
    const { engine, ws, releaseChanges, pullItems } = await startEngineWithHeldPull(getDb(), {
      crdtProvider: provider as unknown as SyncEngineDeps['crdtProvider']
    })
    pullItems.mockImplementation(async (itemIds: string[]) => ({
      items: itemIds.map((id) => ({ ...pullItem(id), type: 'note' }))
    }))

    ws.emit('message', {
      kind: 'changes_available',
      cursor: 9,
      committedAtMs: Date.now(),
      items: [{ ...pullItem('note-n'), type: 'note' }]
    } satisfies SyncSocketEvent)

    await vi.waitFor(() =>
      expect(listCrdtBodyDebts(asSyncDb(getDb().db)).map((d) => [d.noteId, d.reason])).toEqual([
        ['note-n', 'record']
      ])
    )
    expect(engine.hasUnmergedRemoteCrdtState('note-n')).toBe(true)
    expect(batch).not.toHaveBeenCalled()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')

    releaseChanges({
      items: [{ id: 'note-n', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
      deleted: [],
      hasMore: false,
      nextCursor: 9
    })
    await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9'))
    expect(batched).toContainEqual(['note-n'])

    await engine.stop({ skipFinalPush: true })
  })

  // #2409 restack: a remote delete from a frame records its tombstone clock,
  // like a pull page's, so a later re-create of the id is seeded past it.
  it('a delete from a frame records the tombstone clock of a re-creatable id', async () => {
    await mockFilterPayloads()
    const { engine, ws, releaseChanges } = await startEngineWithHeldPull(getDb())

    ws.emit('message', {
      kind: 'changes_available',
      cursor: 9,
      committedAtMs: Date.now(),
      items: [
        {
          ...pullItem('tag-x'),
          type: 'tag_definition',
          operation: 'delete',
          deletedAt: 1_700_000_000,
          clock: { 'device-2': 3 }
        }
      ]
    } satisfies SyncSocketEvent)

    await vi.waitFor(() =>
      expect(getDb().db.select().from(syncTombstoneClocks).all()).toMatchObject([
        { type: 'tag_definition', itemId: 'tag-x', clock: { 'device-2': 3 } }
      ])
    )
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')

    releaseChanges({ items: [], deleted: [], hasMore: false, nextCursor: 9 })
    await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9'))
    await engine.stop({ skipFinalPush: true })
  })

  // #2300: an old server, or a socket that did not opt in, sends no items.
  it('a hint-only frame still wakes the pull and applies nothing on its own', async () => {
    await mockFilterPayloads()
    const { engine, ws, changesCalls, releaseChanges } = await startEngineWithHeldPull(getDb())

    ws.emit('message', { kind: 'changes_available', cursor: 9 } satisfies SyncSocketEvent)

    await vi.waitFor(() => expect(changesCalls()).toBe(1))
    expect(filterName('filter-1')).toBeUndefined()
    releaseChanges({ items: [], deleted: [], hasMore: false, nextCursor: 9 })
    await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9'))

    await engine.stop({ skipFinalPush: true })
  })

  // #2300 review A-1: the pull commits a page's rows before its cursor (a
  // page with post-commit work, or any slice but the last). A frame carrying
  // an older version of a row that page already passed must not undo it.
  describe('a stale frame while the pull owns a newer version', () => {
    type FeedPage = {
      items: Array<{ id: string; type: string; version: number; modifiedAt: number; size: number }>
      deleted: string[]
      hasMore: boolean
      nextCursor: number
    }

    const TOMBSTONE_CLOCK = { 'device-2': 2 }
    const OLD_CLOCK = { 'device-2': 1 }

    const tombstone = (id: string) => ({
      ...pullItem(id),
      operation: 'delete' as const,
      deletedAt: 1_700_000_000,
      clock: TOMBSTONE_CLOCK
    })

    const staleFrame = (): SyncSocketEvent => ({
      kind: 'changes_available',
      cursor: 100,
      committedAtMs: Date.now(),
      items: [{ ...pullItem('filter-x'), clock: OLD_CLOCK }]
    })

    const seedFilterX = (): void => {
      getDb()
        .db.insert(savedFilters)
        .values({ id: 'filter-x', name: 'X', config: {}, clock: OLD_CLOCK })
        .run()
    }

    async function startEngine(deps: SyncEngineDeps): Promise<{
      engine: SyncEngine
      ws: ReturnType<typeof createMockWs>
      setPage: (page: FeedPage) => void
    }> {
      const http = await import('./http-client')
      let page: FeedPage = { items: [], deleted: [], hasMore: false, nextCursor: 0 }
      // A feed, not a fixed answer: a page is served only to a reader below
      // its nextCursor, so a later pull cannot re-deliver the tombstone.
      vi.spyOn(http, 'getFromServer').mockImplementation(async (url: string) => {
        const from = Number(/[?&]cursor=(\d+)/.exec(url)?.[1] ?? 0)
        return from < page.nextCursor
          ? page
          : { items: [], deleted: [], hasMore: false, nextCursor: Math.max(from, page.nextCursor) }
      })
      const ws = deps.ws as unknown as ReturnType<typeof createMockWs>
      const engine = new SyncEngine(deps)
      vi.spyOn(engine, 'fullSync').mockResolvedValue()
      await engine.start()
      engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '4')
      return {
        engine,
        ws,
        setPage: (next) => {
          page = next
        }
      }
    }

    it('a page with a tombstone and a note keeps the row deleted when the stale frame lands during the CRDT batch', async () => {
      await mockFilterPayloads()
      seedFilterX()
      const realApply = ItemApplier.prototype.apply
      vi.spyOn(ItemApplier.prototype, 'apply').mockImplementation(function (
        this: ItemApplier,
        input,
        page
      ) {
        return input.type === 'note'
          ? insertNoteRow(input.itemId)
          : realApply.call(this, input, page)
      })
      const provider = {
        inactiveDocCapacity: 32,
        isNoteLocalOnly: vi.fn(() => false),
        raiseInactiveDocCapacity: vi.fn()
      }
      const ws = createMockWs()
      const { engine, setPage } = await startEngine(
        createMockDeps(getDb(), {
          ws,
          crdtProvider: provider as unknown as SyncEngineDeps['crdtProvider']
        })
      )
      const http = await import('./http-client')
      vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => ({
        items: (body as { itemIds: string[] }).itemIds.map((id) =>
          id === 'filter-x' ? tombstone(id) : { ...pullItem(id), type: 'note' }
        )
      }))
      let enteredCrdt!: () => void
      const crdtEntered = new Promise<void>((resolve) => {
        enteredCrdt = resolve
      })
      let releaseCrdt!: () => void
      vi.spyOn(CrdtSyncCoordinator.prototype, 'applyCrdtBatch').mockImplementation(
        () =>
          new Promise((resolve) => {
            releaseCrdt = () => resolve({ snapshotGets: 0, batchPosts: 0 })
            enteredCrdt()
          })
      )
      setPage({
        items: [{ id: 'note-n', type: 'note', version: 1, modifiedAt: 1, size: 10 }],
        deleted: ['filter-x'],
        hasMore: false,
        nextCursor: 101
      })

      ws.emit('message', { kind: 'changes_available', cursor: 101 } satisfies SyncSocketEvent)
      await crdtEntered
      expect(filterName('filter-x')).toBeUndefined()
      expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')

      ws.emit('message', staleFrame())
      await new Promise((resolve) => setTimeout(resolve, 100))
      releaseCrdt()
      await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('101'))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(filterName('filter-x')).toBeUndefined()
      await engine.stop({ skipFinalPush: true })
    })

    it('a multi-slice page keeps the row deleted when the stale frame lands between slices', async () => {
      await mockFilterPayloads()
      seedFilterX()
      const ws = createMockWs()
      const { engine, setPage } = await startEngine(createMockDeps(getDb(), { ws }))
      const others = Array.from({ length: 100 }, (_, i) => `gone-${i}`)
      let enteredSecondSlice!: () => void
      const secondSliceEntered = new Promise<void>((resolve) => {
        enteredSecondSlice = resolve
      })
      let releaseSecondSlice!: () => void
      const secondSliceHeld = new Promise<void>((resolve) => {
        releaseSecondSlice = resolve
      })
      const http = await import('./http-client')
      vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => {
        const itemIds = (body as { itemIds: string[] }).itemIds
        if (itemIds.includes('gone-99')) {
          enteredSecondSlice()
          await secondSliceHeld
        }
        return { items: itemIds.map(tombstone) }
      })
      setPage({
        items: [],
        deleted: ['filter-x', ...others],
        hasMore: false,
        nextCursor: 101
      })

      ws.emit('message', { kind: 'changes_available', cursor: 101 } satisfies SyncSocketEvent)
      await secondSliceEntered
      // Slice 2's POST is prefetched while slice 1 applies.
      await vi.waitFor(() => expect(filterName('filter-x')).toBeUndefined())

      ws.emit('message', staleFrame())
      await new Promise((resolve) => setTimeout(resolve, 100))
      releaseSecondSlice()
      await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('101'))
      await new Promise((resolve) => setTimeout(resolve, 50))

      expect(filterName('filter-x')).toBeUndefined()
      await engine.stop({ skipFinalPush: true })
    })

    // #2300 review A-L2: a run that stops mid-page (here slice 2 answers with
    // no pull envelope, a cursor-holding refusal) committed slice 1 but not
    // LAST_CURSOR. The owned-through mark outlives the run until LAST_CURSOR
    // reaches it, so a stale frame below the page stays covered.
    it('a run refused mid-page keeps a stale frame covered', async () => {
      await mockFilterPayloads()
      seedFilterX()
      const ws = createMockWs()
      const { engine, setPage } = await startEngine(createMockDeps(getDb(), { ws }))
      const others = Array.from({ length: 100 }, (_, i) => `gone-${i}`)
      const http = await import('./http-client')
      const pullSpy = vi.spyOn(http, 'postToServer').mockImplementation(async (_path, body) => {
        const itemIds = (body as { itemIds: string[] }).itemIds
        if (itemIds.includes('gone-99')) return { notAnEnvelope: true }
        return { items: itemIds.map(tombstone) }
      })
      setPage({ items: [], deleted: ['filter-x', ...others], hasMore: false, nextCursor: 101 })

      ws.emit('message', { kind: 'changes_available', cursor: 101 } satisfies SyncSocketEvent)
      await vi.waitFor(() =>
        expect(
          pullSpy.mock.calls.some(([, body]) =>
            (body as { itemIds: string[] }).itemIds.includes('gone-99')
          )
        ).toBe(true)
      )
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(filterName('filter-x')).toBeUndefined()
      expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')

      // The next pull has not re-read the page yet: the feed serves nothing new.
      setPage({ items: [], deleted: [], hasMore: false, nextCursor: 0 })
      ws.emit('message', staleFrame())
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(filterName('filter-x')).toBeUndefined()

      // Above the page the fast path is live.
      ws.emit('message', frame(['filter-2'], 102))
      await vi.waitFor(() => expect(filterName('filter-2')).toBe('name of filter-2'))
      await engine.stop({ skipFinalPush: true })
    })
  })

  // #2300 review B-F1: a fast-path conflict requeue coalesces into the queue
  // row a push already dequeued, and that push's ack deletes it (protocol 06
  // §6.6.2). Three writers: X pushes its merged row, Z's concurrent edit
  // arrives on the socket meanwhile. The fast path stays out until the push
  // settles, then applies (review B-L3: it waits instead of dropping).
  it('a frame that arrives while a push is in flight waits for it, then applies', async () => {
    await mockFilterPayloads()
    let inFlight = true
    vi.spyOn(PushCoordinator.prototype, 'pushInFlight', 'get').mockImplementation(() => inFlight)
    let settle!: (settled: boolean) => void
    vi.spyOn(PushCoordinator.prototype, 'whenPushSettled').mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          settle = resolve
        })
    )
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')
    const { engine, ws, releaseChanges } = await startEngineWithHeldPull(getDb())

    ws.emit('message', frame(['filter-1'], 9))
    await new Promise((resolve) => setTimeout(resolve, 100))
    expect(applySpy).not.toHaveBeenCalled()
    expect(filterName('filter-1')).toBeUndefined()

    inFlight = false
    settle(true)
    await vi.waitFor(() => expect(filterName('filter-1')).toBe('name of filter-1'))
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('4')

    releaseChanges({ items: [], deleted: [], hasMore: false, nextCursor: 9 })
    await vi.waitFor(() => expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('9'))
    await engine.stop({ skipFinalPush: true })
  })
})
