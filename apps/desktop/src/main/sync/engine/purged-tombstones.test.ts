import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import type { VectorClock } from '@memry/contracts/sync-api'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { projects } from '@memry/db-schema/schema/projects'
import { tasks } from '@memry/db-schema/schema/tasks'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { createMockDeps, setupTestDb, type TestDatabaseResult } from '@tests/utils/engine-mocks'
import { EVENT_CHANNELS } from '@memry/contracts/ipc-events'
import { SyncEngine } from '../engine'
import * as bulkApply from '../bulk-apply'
import { ItemApplier } from '../apply-item'
import { SYNC_STATE_KEYS } from './sync-context'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-purged-tombstones-test' }
}))

// The note handler reads its row through the app's data DB handle.
const currentDb: { db: TestDatabaseResult | null } = { db: null }
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => currentDb.db!.db
}))

vi.mock('../../lib/logger', () => {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
  return { createLogger: () => logger }
})

/**
 * #2302: every client path by which a purged tombstone or a lost blob could
 * delete local data, driven through the real engine, applier, handlers and
 * data DB. A purged tombstone must delete exactly what the same tombstone
 * delivered signed deletes (protocol 05 §5.8: a local clock strictly after
 * the tombstone keeps the item); absence and blobMissing must delete nothing.
 */

type RowType = 'task' | 'project' | 'tag_definition'

const TOMBSTONE_CLOCK: VectorClock = { 'device-a': 2, 'device-b': 1 }

const CLOCK_RELATIONS: Array<{ relation: string; local: VectorClock; survives: boolean }> = [
  { relation: 'before', local: { 'device-a': 1 }, survives: false },
  { relation: 'equal', local: { ...TOMBSTONE_CLOCK }, survives: false },
  { relation: 'concurrent', local: { 'device-a': 1, 'device-c': 1 }, survives: false },
  {
    relation: 'strictly after',
    local: { 'device-a': 2, 'device-b': 1, 'device-c': 1 },
    survives: true
  }
]

const seedRow = (db: TestDatabaseResult, type: RowType, id: string, clock: VectorClock): void => {
  if (type === 'project') {
    db.db.insert(projects).values({ id, name: id, color: '#000', position: 0, clock }).run()
  } else if (type === 'task') {
    db.db
      .insert(projects)
      .values({ id: 'proj-parent', name: 'Parent', color: '#000', position: 0 })
      .onConflictDoNothing()
      .run()
    db.db
      .insert(tasks)
      .values({ id, projectId: 'proj-parent', title: id, priority: 0, position: 0, clock })
      .run()
  } else {
    // Created before the tombstones below were deleted: a stale copy, not a re-create.
    db.db
      .insert(tagDefinitions)
      .values({ name: id, color: 'blue', clock, createdAt: '2020-01-01T00:00:00.000Z' })
      .run()
  }
}

const localRow = (db: TestDatabaseResult, type: RowType, id: string): unknown => {
  if (type === 'project') return db.db.select().from(projects).where(eq(projects.id, id)).get()
  if (type === 'task') return db.db.select().from(tasks).where(eq(tasks.id, id)).get()
  return db.db.select().from(tagDefinitions).where(eq(tagDefinitions.name, id)).get()
}

const signedTombstone = (id: string, type: string, clock: VectorClock) => ({
  id,
  type,
  operation: 'delete',
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  deletedAt: 1_700_000_000,
  clock
})

const purgedTombstone = (id: string, type: string, clock?: VectorClock) => ({
  id,
  type,
  deletedAt: 1_700_000_000,
  ...(clock ? { clock } : {}),
  serverCursor: 5
})

const signedItem = (id: string, type = 'task') => ({
  id,
  type,
  operation: 'update',
  cryptoVersion: 1,
  blob: { encryptedKey: 'ek', keyNonce: 'kn', encryptedData: 'ed', dataNonce: 'dn' },
  signature: 'sig',
  signerDeviceId: 'device-2',
  clock: { 'device-2': 1 }
})

interface ServerPage {
  deleted?: string[]
  items?: Array<{ id: string; type: string }>
  pull: Record<string, unknown>
  nextCursor?: number
}

const servePage = async ({ deleted = [], items = [], pull, nextCursor = 7 }: ServerPage) => {
  const http = await import('../http-client')
  vi.spyOn(http, 'getFromServer').mockResolvedValue({
    items: items.map((ref) => ({ ...ref, version: 1, modifiedAt: 1000, size: 10 })),
    deleted,
    hasMore: false,
    nextCursor
  })
  return vi.spyOn(http, 'postToServer').mockResolvedValue(pull)
}

const mockDecrypt = async (): Promise<void> => {
  vi.spyOn(await import('../decrypt'), 'decryptItemFromPull').mockReturnValue({
    content: new TextEncoder().encode(JSON.stringify({ title: 'from B' })),
    verified: true
  })
}

/** A device that has pulled before: its run starts past cursor 0, so purged tombstones apply. */
const syncedEngine = (db: TestDatabaseResult): SyncEngine => {
  const engine = new SyncEngine(createMockDeps(db))
  engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
  return engine
}

describe('purged tombstones and lost blobs on the desktop pull (#2302)', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  // D1: a purged tombstone in the cursor page is the same delete as the signed one.
  describe.each<RowType>(['task', 'project', 'tag_definition'])(
    'a purged %s tombstone deletes exactly what the signed tombstone deletes',
    (type) => {
      it.each(CLOCK_RELATIONS)(
        'local clock $relation the tombstone: survives=$survives',
        async ({ local, survives }) => {
          const db = getDb()
          seedRow(db, type, 'x-purged', local)
          seedRow(db, type, 'x-signed', local)
          const engine = syncedEngine(db)
          await servePage({
            deleted: ['x-purged', 'x-signed'],
            pull: {
              items: [signedTombstone('x-signed', type, TOMBSTONE_CLOCK)],
              purgedTombstones: [purgedTombstone('x-purged', type, TOMBSTONE_CLOCK)]
            }
          })
          await mockDecrypt()

          await expect(engine.pull()).resolves.toBe(true)

          expect(localRow(db, type, 'x-signed') !== undefined).toBe(survives)
          expect(localRow(db, type, 'x-purged') !== undefined).toBe(survives)
          expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
        }
      )
    }
  )

  // D1b: an unsigned delete without a clock would apply unconditionally.
  it('refuses a clockless purged tombstone and keeps the local row', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task')] }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'task', 'task-1')).toBeDefined()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
  })

  // D1c / D1d: a clock-free type, or an id this slice never asked for.
  it('refuses a purged tombstone for a clock-free type or an unrequested id', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-other', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['general'],
      pull: {
        items: [],
        purgedTombstones: [
          purgedTombstone('general', 'settings', { 'device-a': 9 }),
          purgedTombstone('task-other', 'task', { 'device-a': 9 })
        ]
      }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await engine.pull()

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'task', 'task-other')).toBeDefined()
  })

  // D1e: ids repeat across types; the delete is keyed (type, id).
  it('deletes only the tag when a purged tag tombstone shares its id with a project', async () => {
    const db = getDb()
    seedRow(db, 'tag_definition', 'inbox', { 'device-a': 1 })
    seedRow(db, 'project', 'inbox', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['inbox'],
      pull: {
        items: [],
        purgedTombstones: [purgedTombstone('inbox', 'tag_definition', TOMBSTONE_CLOCK)]
      }
    })

    await engine.pull()

    expect(localRow(db, 'tag_definition', 'inbox')).toBeUndefined()
    expect(localRow(db, 'project', 'inbox')).toBeDefined()
  })

  // N5: a lost blob is recorded and quarantined, never applied, never a delete.
  it('records a blobMissing entry, applies nothing to it, keeps the row, and advances the cursor', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-lost', { 'device-a': 1 })
    const before = localRow(db, 'task', 'task-lost')
    const engine = syncedEngine(db)
    await servePage({
      items: [
        { id: 'task-lost', type: 'task' },
        { id: 'task-ok', type: 'task' }
      ],
      pull: {
        items: [signedItem('task-ok')],
        blobMissing: [{ id: 'task-lost', type: 'task', serverCursor: 4 }]
      }
    })
    await mockDecrypt()
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual(['task-ok'])
    expect(localRow(db, 'task', 'task-lost')).toEqual(before)
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
    const ledger = engine['pullCoordinator'].schemaInvalid
    expect(ledger.has('task', 'task-lost')).toBe(true)
    expect(ledger.quarantinedItems()[0].lastError).toContain('blob_missing')
  })

  // N4: an id in `deleted` the server returns nothing for (a pre-#2302 purge,
  // or an old server) is not a delete.
  it('leaves the local row untouched when a deleted id comes back with no entry of any kind', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({ deleted: ['task-1'], pull: { items: [] } })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'task', 'task-1')).toBeDefined()
  })

  // N6: a full re-pull from cursor 0 (24 h reset, rePullNeeded) against a server
  // that holds no row for X, which is what a legacy hard-delete left behind.
  it('keeps a synced local row the server no longer has after a re-pull from cursor 0', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-legacy-purged', { 'device-a': 3 })
    const engine = syncedEngine(db)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '0')
    await servePage({
      items: [{ id: 'task-other', type: 'task' }],
      pull: { items: [signedItem('task-other')] }
    })
    await mockDecrypt()
    vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(engine.pull()).resolves.toBe(true)

    expect(localRow(db, 'task', 'task-legacy-purged')).toBeDefined()
  })

  // Old-server compat: a pull body without the sibling lists behaves as before.
  it('applies a pre-#2302 pull body exactly as before', async () => {
    const db = getDb()
    const engine = syncedEngine(db)
    await servePage({
      items: [{ id: 'task-ok', type: 'task' }],
      pull: { items: [signedItem('task-ok')] }
    })
    await mockDecrypt()
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply').mockReturnValue('applied')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy.mock.calls.map(([input]) => input.itemId)).toEqual(['task-ok'])
    expect(engine['pullCoordinator'].schemaInvalid.quarantinedItems()).toEqual([])
  })

  // #2302 review (B-8): a fresh or reset device applies no purged tombstone.
  it('applies no purged tombstone in a run that starts from cursor 0', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const engine = new SyncEngine(createMockDeps(db))
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task', TOMBSTONE_CLOCK)] }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'task', 'task-1')).toBeDefined()
  })

  // #2302 review (A-F2): an unsigned delete never takes the handler's clockless branch.
  it('refuses a purged tombstone over a clockless local row', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', null as unknown as VectorClock)
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task', TOMBSTONE_CLOCK)] }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await engine.pull()

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'task', 'task-1')).toBeDefined()
  })

  // #2302 review (A-F2 scenario A): a vault folder restored from a backup; the
  // indexer wrote the note row with no clock. Neither the first sync nor a later
  // pull that meets the marker unlinks the file.
  it('keeps a restored, clockless note across the first sync and a later pull with its marker', async () => {
    const db = getDb()
    currentDb.db = db
    db.db
      .insert(noteMetadata)
      .values({
        id: 'note-restored',
        path: 'restored.md',
        title: 'Restored',
        createdAt: '2020-01-01T00:00:00.000Z',
        modifiedAt: '2020-01-01T00:00:00.000Z'
      })
      .run()
    const engine = new SyncEngine(createMockDeps(db))
    await servePage({
      deleted: ['note-restored'],
      pull: {
        items: [],
        purgedTombstones: [purgedTombstone('note-restored', 'note', TOMBSTONE_CLOCK)]
      }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await expect(engine.pull()).resolves.toBe(true)
    await expect(engine.pull()).resolves.toBe(true)

    expect(applySpy).not.toHaveBeenCalled()
    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
    expect(
      db.db.select().from(noteMetadata).where(eq(noteMetadata.id, 'note-restored')).get()
    ).toBeDefined()
  })

  // #2302 review (A-F2 scenario B, B-4): the user re-created a recreatable item
  // and its create is still queued. The server will accept that create over the
  // marker, so the pull must not delete it first.
  it('keeps a re-created tag whose create is still queued when its marker arrives', async () => {
    const db = getDb()
    seedRow(db, 'tag_definition', 'work', { 'device-b': 1 })
    const deps = createMockDeps(db)
    deps.queue.enqueue({
      type: 'tag_definition',
      itemId: 'work',
      operation: 'create',
      payload: '{}'
    })
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
    await servePage({
      deleted: ['work'],
      pull: {
        items: [],
        purgedTombstones: [purgedTombstone('work', 'tag_definition', TOMBSTONE_CLOCK)]
      }
    })
    const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')

    await engine.pull()

    expect(applySpy).not.toHaveBeenCalled()
    expect(localRow(db, 'tag_definition', 'work')).toBeDefined()
    expect(deps.queue.getPendingCount()).toBe(1)
  })

  /** LAST_CURSOR and the ITEM_SYNCED count as the (single) slice commit starts. */
  const recordAtCommit = (engine: SyncEngine, emit: unknown) => {
    const seen: Array<{ cursor?: string; itemSynced: number }> = []
    const begin = bulkApply.beginPageApply
    vi.spyOn(bulkApply, 'beginPageApply').mockImplementation((db) => {
      const handle = begin(db)
      const commit = handle.commit.bind(handle)
      handle.commit = () => {
        seen.push({
          cursor: engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR),
          itemSynced: (emit as ReturnType<typeof vi.fn>).mock.calls.filter(
            ([channel]) => channel === EVENT_CHANNELS.ITEM_SYNCED
          ).length
        })
        commit()
      }
      return handle
    })
    return seen
  }

  // #2302 with #2294: an applied purged tombstone is an ordinary in-transaction
  // delete, so the page's cursor still commits inside the slice, and its
  // item-synced event waits for the commit.
  it('applies a purged tombstone inside the slice transaction that carries the cursor', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const deps = createMockDeps(db)
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
    const seen = recordAtCommit(engine, deps.emitToRenderer)
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task', TOMBSTONE_CLOCK)] }
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(seen).toEqual([{ cursor: '7', itemSynced: 0 }])
    expect(localRow(db, 'task', 'task-1')).toBeUndefined()
    expect(
      (deps.emitToRenderer as ReturnType<typeof vi.fn>).mock.calls.filter(
        ([channel]) => channel === EVENT_CHANNELS.ITEM_SYNCED
      )
    ).toHaveLength(1)
  })

  // #2302 with #2294: a refused or skipped purged tombstone is never applied and
  // adds no post-commit work, so the cursor rule is unchanged.
  it('keeps the in-slice cursor when every purged tombstone is refused or skipped', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-clockless', null as unknown as VectorClock)
    const deps = createMockDeps(db)
    const engine = new SyncEngine(deps)
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
    const seen = recordAtCommit(engine, deps.emitToRenderer)
    await servePage({
      deleted: ['task-clockless', 'task-other'],
      pull: {
        items: [],
        purgedTombstones: [
          purgedTombstone('task-clockless', 'task', TOMBSTONE_CLOCK),
          purgedTombstone('task-unrequested', 'task', TOMBSTONE_CLOCK),
          purgedTombstone('task-other', 'task')
        ]
      }
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(seen).toEqual([{ cursor: '7', itemSynced: 0 }])
    expect(localRow(db, 'task', 'task-clockless')).toBeDefined()
  })
})
