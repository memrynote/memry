import { afterEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import sodium from 'libsodium-wrappers-sumo'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { CBOR_FIELD_ORDER } from '@memry/contracts/cbor-ordering'
import { deleteAttestationPayload, deleteClaimOf } from '@memry/contracts/delete-attestation'
import type { SyncEngineDeps } from '../engine'
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
import { createLogger } from '../../lib/logger'
import { signPayload } from '../../crypto/signatures'

vi.mock('electron', () => ({
  app: { getVersion: () => '1.0.0', getPath: () => '/tmp/memry-purged-tombstones-test' }
}))

// The note handler reads its row through the app's data DB handle.
const currentDb: { db: TestDatabaseResult | null } = { db: null }
vi.mock('../../database/client', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getDatabase: () => currentDb.db!.db
}))

// The note matrix rows keep a real file here; the handler resolves note paths against it.
const vault = vi.hoisted(() => ({ dir: '' }))
vi.mock('../../vault/notes-io', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  getVaultRoot: () => vault.dir,
  toAbsolutePath: (relativePath: string) => path.join(vault.dir, relativePath)
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

await sodium.ready
const SIGNER = 'device-a'
const signerKeys = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(7))
const attackerKeys = sodium.crypto_sign_seed_keypair(new Uint8Array(32).fill(9))
const toB64 = (bytes: Uint8Array): string =>
  sodium.to_base64(bytes, sodium.base64_variants.ORIGINAL)

/** #2408: device-a's delete attestation over exactly this claim. */
const attestationFor = (
  claim: { id: string; type: string; clock: VectorClock; deletedAt: number },
  secretKey: Uint8Array = signerKeys.privateKey
): string => {
  const parsed = deleteClaimOf({ ...claim, operation: 'delete' })
  if (!parsed) throw new Error(`not attestable: ${claim.type}/${claim.id}`)
  return toB64(
    signPayload(deleteAttestationPayload(parsed), CBOR_FIELD_ORDER.DELETE_ATTESTATION, secretKey)
  )
}

/** Engine deps whose key resolver knows device-a and the item signer device-2, nothing else. */
const mockDeps = (db: TestDatabaseResult, overrides?: Partial<SyncEngineDeps>): SyncEngineDeps =>
  createMockDeps(db, {
    getDevicePublicKey: vi.fn(async (deviceId: string) =>
      deviceId === SIGNER
        ? signerKeys.publicKey
        : deviceId === 'device-2'
          ? new Uint8Array(32)
          : null
    ),
    ...overrides
  })

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

const DELETED_AT = 1_700_000_000

/** A marker shed before attestations existed (or an old client's delete). */
const legacyTombstone = (id: string, type: string, clock?: VectorClock) => ({
  id,
  type,
  deletedAt: DELETED_AT,
  ...(clock ? { clock } : {}),
  serverCursor: 5
})

/** A purged tombstone as a current server serves it: attested by device-a when attestable. */
const purgedTombstone = (id: string, type: string, clock?: VectorClock) => {
  const entry = legacyTombstone(id, type, clock)
  return clock && deleteClaimOf({ ...entry, operation: 'delete' })
    ? {
        ...entry,
        signerDeviceId: SIGNER,
        deleteAttestation: attestationFor({ id, type, clock, deletedAt: DELETED_AT })
      }
    : entry
}

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
  const engine = new SyncEngine(mockDeps(db))
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
    const engine = new SyncEngine(mockDeps(db))
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
    const engine = new SyncEngine(mockDeps(db))
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
    const deps = mockDeps(db)
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
    const deps = mockDeps(db)
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
    const deps = mockDeps(db)
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

/**
 * #2408: a purged tombstone applies only when the deleting device's
 * attestation verifies over the entry's own (type, id, clock, deletedAt).
 * Every row below would be deleted by the unsigned #2302 path: the local
 * clock is dominated by the served one and nothing local refuses it.
 */
describe('#2408 attestation: a forged or missing attestation never deletes', () => {
  const { getDb } = setupTestDb()

  afterEach(() => {
    vi.restoreAllMocks()
  })

  type MatrixType = RowType | 'note'
  const ID = 'x-1'
  const LOCAL_CLOCK: VectorClock = { 'device-a': 1 }
  const NOTE_BYTES = '---\nid: x-1\n---\n# Keep me\n'

  const seedMatrixRow = (db: TestDatabaseResult, type: MatrixType): void => {
    if (type !== 'note') {
      seedRow(db, type, ID, LOCAL_CLOCK)
      return
    }
    currentDb.db = db
    vault.dir = mkdtempSync(path.join(tmpdir(), 'memry-2408-'))
    writeFileSync(path.join(vault.dir, `${ID}.md`), NOTE_BYTES)
    db.db
      .insert(noteMetadata)
      .values({
        id: ID,
        path: `${ID}.md`,
        title: 'Keep me',
        clock: LOCAL_CLOCK,
        createdAt: '2020-01-01T00:00:00.000Z',
        modifiedAt: '2020-01-01T00:00:00.000Z'
      })
      .run()
  }

  const matrixRow = (db: TestDatabaseResult, type: MatrixType): unknown =>
    type === 'note'
      ? db.db.select().from(noteMetadata).where(eq(noteMetadata.id, ID)).get()
      : localRow(db, type, ID)

  const claim = (
    type: string,
    overrides: Partial<{ id: string; type: string; clock: VectorClock; deletedAt: number }> = {}
  ) => ({
    id: ID,
    type,
    clock: TOMBSTONE_CLOCK,
    deletedAt: DELETED_AT,
    ...overrides
  })

  /** Each forged entry and the refusal it must earn; served for (type, ID, TOMBSTONE_CLOCK). */
  const CASES: Array<{
    name: string
    reason: 'unattested' | 'signer_unknown' | 'attestation_invalid'
    entry: (type: string) => Record<string, unknown>
  }> = [
    {
      name: '1 a legacy marker with no attestation fields',
      reason: 'unattested',
      entry: (type) => legacyTombstone(ID, type, TOMBSTONE_CLOCK)
    },
    {
      name: '2a deleteAttestation without signerDeviceId',
      reason: 'unattested',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        deleteAttestation: attestationFor(claim(type))
      })
    },
    {
      name: '2b signerDeviceId without deleteAttestation',
      reason: 'unattested',
      entry: (type) => ({ ...legacyTombstone(ID, type, TOMBSTONE_CLOCK), signerDeviceId: SIGNER })
    },
    {
      name: '3 an attacker key under a real device id',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: attestationFor(claim(type), attackerKeys.privateKey)
      })
    },
    {
      name: '4 a valid attestation served with an inflated clock',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...purgedTombstone(ID, type, TOMBSTONE_CLOCK),
        clock: { x: 2 ** 31 }
      })
    },
    {
      name: '5 a valid attestation served with a raised deletedAt',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...purgedTombstone(ID, type, TOMBSTONE_CLOCK),
        deletedAt: DELETED_AT + 1
      })
    },
    {
      name: '6 a valid attestation for another type with the same id',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: attestationFor(
          claim(type === 'tag_definition' ? 'project' : 'tag_definition')
        )
      })
    },
    {
      name: '7 a valid attestation for another id',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: attestationFor(claim(type, { id: 'x-other' }))
      })
    },
    {
      name: "8 the tombstone's own item signature replayed",
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: toB64(
          signPayload(
            {
              id: ID,
              type,
              operation: 'delete',
              cryptoVersion: 1,
              encryptedKey: 'ek',
              keyNonce: 'kn',
              encryptedData: 'ed',
              dataNonce: 'dn',
              deletedAt: DELETED_AT,
              metadata: { clock: TOMBSTONE_CLOCK }
            },
            CBOR_FIELD_ORDER.SYNC_ITEM,
            signerKeys.privateKey
          )
        )
      })
    },
    {
      name: '9 a CRDT update signature replayed',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: toB64(
          sodium.crypto_sign_detached(
            new Uint8Array([...new TextEncoder().encode(ID), 1, 2, 3]),
            signerKeys.privateKey
          )
        )
      })
    },
    {
      name: '10a a truncated signature',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...purgedTombstone(ID, type, TOMBSTONE_CLOCK),
        deleteAttestation: attestationFor(claim(type)).slice(0, 40)
      })
    },
    {
      name: '10b a signature that is not base64',
      reason: 'attestation_invalid',
      entry: (type) => ({ ...purgedTombstone(ID, type, TOMBSTONE_CLOCK), deleteAttestation: '%%%' })
    },
    {
      name: '11 a signer absent from the cache and from /auth/devices',
      reason: 'signer_unknown',
      entry: (type) => ({
        ...purgedTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: 'device-gone'
      })
    },
    {
      name: '12 a stale attestation from an earlier delete on a marker whose clock moved',
      reason: 'attestation_invalid',
      entry: (type) => ({
        ...legacyTombstone(ID, type, TOMBSTONE_CLOCK),
        signerDeviceId: SIGNER,
        deleteAttestation: attestationFor(
          claim(type, { clock: { 'device-a': 1 }, deletedAt: DELETED_AT - 100 })
        )
      })
    }
  ]

  describe.each<MatrixType>(['task', 'project', 'note', 'tag_definition'])('%s', (type) => {
    it.each(CASES)(
      '$name: refused as $reason, nothing changes, cursor advances',
      async ({ reason, entry }) => {
        const db = getDb()
        seedMatrixRow(db, type)
        const before = matrixRow(db, type)
        expect(before).toBeDefined()
        const deps = mockDeps(db)
        const engine = new SyncEngine(deps)
        engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
        await servePage({ deleted: [ID], pull: { items: [], purgedTombstones: [entry(type)] } })
        const applySpy = vi.spyOn(ItemApplier.prototype, 'apply')
        const warn = vi.mocked(createLogger('PullEnvelope').warn)
        warn.mockClear()

        await expect(engine.pull()).resolves.toBe(true)

        expect(applySpy).not.toHaveBeenCalled()
        expect(matrixRow(db, type)).toEqual(before)
        if (type === 'note') {
          expect(readFileSync(path.join(vault.dir, `${ID}.md`), 'utf8')).toBe(NOTE_BYTES)
        }
        expect(warn).toHaveBeenCalledWith('Pull: refused purged tombstones', { [reason]: 1 })
        expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('7')
        expect(deps.queue.getPendingCount()).toBe(0)
      }
    )
  })

  // #2408 A2: a pre-attestation marker whose clock dominates a clean, synced
  // row is still refused. No local evidence tells a real clock from a forged one.
  it('keeps a clean synced row under a legacy marker that dominates it', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-synced', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['task-synced'],
      pull: {
        items: [],
        purgedTombstones: [legacyTombstone('task-synced', 'task', { 'device-a': 9 })]
      }
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(localRow(db, 'task', 'task-synced')).toBeDefined()
  })

  // #2408 positive control: a signer revoked since, but whose key this device cached, still applies.
  it('applies an attestation from a revoked signer whose key is cached', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const engine = syncedEngine(db)
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task', TOMBSTONE_CLOCK)] }
    })

    await expect(engine.pull()).resolves.toBe(true)

    expect(localRow(db, 'task', 'task-1')).toBeUndefined()
  })

  // #2408: a transient key-resolution failure is not a refusal. The page fails
  // and the cursor holds, so the same entry is verified on the next pull.
  it('holds the cursor and refuses nothing when /auth/devices fails', async () => {
    const db = getDb()
    seedRow(db, 'task', 'task-1', { 'device-a': 1 })
    const engine = new SyncEngine(
      mockDeps(db, { getDevicePublicKey: vi.fn().mockRejectedValue(new Error('offline')) })
    )
    engine.setStateValue(SYNC_STATE_KEYS.LAST_CURSOR, '3')
    await servePage({
      deleted: ['task-1'],
      pull: { items: [], purgedTombstones: [purgedTombstone('task-1', 'task', TOMBSTONE_CLOCK)] }
    })
    const warn = vi.mocked(createLogger('PullEnvelope').warn)
    warn.mockClear()

    await engine.pull()

    expect(engine.getStateValue(SYNC_STATE_KEYS.LAST_CURSOR)).toBe('3')
    expect(localRow(db, 'task', 'task-1')).toBeDefined()
    expect(warn).not.toHaveBeenCalledWith('Pull: refused purged tombstones', expect.anything())
  })
})
