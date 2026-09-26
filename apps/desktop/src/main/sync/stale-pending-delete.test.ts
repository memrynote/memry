import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * #2423: a pending delete recorded before a re-create of the same id must not
 * be replayed over the live item at start-up, and a delete raised with no
 * snapshot must never push a clock minted from `{}`. Real migrated data DB, the
 * real queue, the real sync services, `recoverDirtyItems` and the start-up
 * seed. The only mock is the module-level `getDatabase()` handle.
 */
let activeDb: unknown = null

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/client')>()),
  getDatabase: () => activeDb
}))

import { and, eq } from 'drizzle-orm'
import { asClientDb, createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { VectorClock } from '@memry/contracts/sync-api'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { tagCategories } from '@memry/db-schema/schema/tag-categories'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { syncPendingDeletes } from '@memry/db-schema/schema/sync-pending-deletes'
import { syncTombstoneClocks } from '@memry/db-schema/schema/sync-tombstone-clocks'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import {
  initTagCategorySyncService,
  resetTagCategorySyncService
} from '@memry/sync-client/tag-category-sync'
import {
  initFolderConfigSyncService,
  resetFolderConfigSyncService
} from '@memry/sync-client/folder-config-sync'
import {
  initCanvasFolderSyncService,
  resetCanvasFolderSyncService
} from '@memry/sync-client/canvas-folder-sync'
import { initBookmarkSyncService, resetBookmarkSyncService } from '@memry/sync-client/bookmark-sync'
import {
  initCalendarSourceSyncService,
  resetCalendarSourceSyncService
} from '@memry/sync-client/calendar-source-sync'
import {
  initCalendarExternalEventSyncService,
  resetCalendarExternalEventSyncService
} from '@memry/sync-client/calendar-external-event-sync'
import {
  initCalendarBindingSyncService,
  resetCalendarBindingSyncService
} from '@memry/sync-client/calendar-binding-sync'
import type { DataDb } from '../database/client'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import { enqueueLocalSyncCreate, enqueueLocalSyncDelete } from './local-mutations'
import { recoverDirtyItems } from './dirty-recovery'
import { getRemoteSyncAdapter } from './item-handlers'
import { runInitialSeed } from './initial-seed'

const DEVICE = 'device-A'
const SOURCE_ID = 'google-calendar:primary'

interface ServiceDeps {
  db: DataDb
  queue: SyncQueueManager
  getDeviceId: () => string
}

interface Fixture {
  id: string
  insert(db: DataDb, clock: VectorClock | null): void
  remove(db: DataDb): void
  snapshot(db: DataDb): string
  init(deps: ServiceDeps): void
}

const FIXTURES = {
  tag_definition: {
    id: 'work',
    insert: (db, clock) =>
      db.insert(tagDefinitions).values({ name: 'work', color: 'red', clock }).run(),
    remove: (db) => db.delete(tagDefinitions).where(eq(tagDefinitions.name, 'work')).run(),
    snapshot: (db) =>
      JSON.stringify(db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()),
    init: (deps) => initTagDefinitionSyncService(deps)
  },
  folder_config: {
    id: 'Projects/Work',
    insert: (db, clock) =>
      db.insert(folderConfigs).values({ path: 'Projects/Work', icon: null, clock }).run(),
    remove: (db) => db.delete(folderConfigs).where(eq(folderConfigs.path, 'Projects/Work')).run(),
    snapshot: (db) =>
      JSON.stringify(
        db.select().from(folderConfigs).where(eq(folderConfigs.path, 'Projects/Work')).get()
      ),
    init: (deps) => initFolderConfigSyncService(deps)
  },
  bookmark: {
    id: 'bmk_note_n1',
    insert: (db, clock) =>
      db
        .insert(bookmarks)
        .values({ id: 'bmk_note_n1', itemType: 'note', itemId: 'n1', clock })
        .run(),
    remove: (db) => db.delete(bookmarks).where(eq(bookmarks.id, 'bmk_note_n1')).run(),
    snapshot: (db) =>
      JSON.stringify(db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_n1')).get()),
    init: (deps) => initBookmarkSyncService(deps)
  }
} satisfies Record<string, Fixture>

type AcceptanceType = keyof typeof FIXTURES
const ACCEPTANCE_TYPES = Object.keys(FIXTURES) as AcceptanceType[]

describe('a stale pending delete at start-up (#2423)', () => {
  let dataDb: TestDatabaseResult
  let db: DataDb
  let queue: SyncQueueManager

  beforeEach(() => {
    dataDb = createTestDataDb()
    db = asClientDb(dataDb.db)
    activeDb = db
    queue = new SyncQueueManager(db)
    db.insert(syncDevices)
      .values({
        id: DEVICE,
        name: 'Test device',
        platform: 'darwin',
        appVersion: '2026.9.24',
        linkedAt: new Date(),
        isCurrentDevice: true,
        signingPublicKey: 'pk'
      })
      .run()
    db.insert(calendarSources)
      .values({
        id: SOURCE_ID,
        provider: 'google',
        kind: 'calendar',
        remoteId: 'primary',
        title: 'P'
      })
      .run()
    markSyncEligible()
  })

  afterEach(() => {
    resetTagDefinitionSyncService()
    resetTagCategorySyncService()
    resetFolderConfigSyncService()
    resetCanvasFolderSyncService()
    resetBookmarkSyncService()
    resetCalendarSourceSyncService()
    resetCalendarExternalEventSyncService()
    resetCalendarBindingSyncService()
    resetNoteSyncService()
    markSyncIneligible()
    activeDb = null
    dataDb.close()
  })

  const deps = (): ServiceDeps => ({ db, queue, getDeviceId: () => DEVICE })

  const queuedOps = (type: string, itemId: string): string[] =>
    db
      .select({ operation: syncQueue.operation })
      .from(syncQueue)
      .where(and(eq(syncQueue.type, type), eq(syncQueue.itemId, itemId)))
      .all()
      .map((row) => row.operation)

  const pendingDeleteOf = (itemId: string): unknown =>
    db.select().from(syncPendingDeletes).where(eq(syncPendingDeletes.itemId, itemId)).get()

  /** A delete recorded by a build before #2409: a pending delete and no tombstone clock. */
  const deleteWithRuntimeDown = (type: AcceptanceType): void => {
    const fixture = FIXTURES[type]
    fixture.insert(db, { [DEVICE]: 2 })
    enqueueLocalSyncDelete(type, fixture.id, fixture.snapshot(db))
    fixture.remove(db)
    db.delete(syncTombstoneClocks).run()
    expect(pendingDeleteOf(fixture.id)).toBeDefined()
  }

  /** The sync runtime start. Every enqueue requests a push, so a queued row can leave now. */
  const startRuntime = (type: AcceptanceType): void => {
    FIXTURES[type].init(deps())
    recoverDirtyItems(db)
  }

  /** The first full sync's seed of clockless rows, after the pull. */
  const seed = (type: AcceptanceType): void => {
    runInitialSeed({ db, queue, deviceId: DEVICE, adapters: [getRemoteSyncAdapter(type)!] })
  }

  it.each(ACCEPTANCE_TYPES)(
    '%s: a runtime-down delete then re-create, with no tombstone clock, is pushed live (#2423)',
    (type) => {
      const fixture = FIXTURES[type]
      deleteWithRuntimeDown(type)

      fixture.insert(db, null)
      enqueueLocalSyncCreate(type, fixture.id)
      startRuntime(type)

      expect(queuedOps(type, fixture.id)).not.toContain('delete')

      seed(type)
      const ops = queuedOps(type, fixture.id)
      expect(ops).toHaveLength(1)
      expect(['create', 'update']).toContain(ops[0])
      expect(pendingDeleteOf(fixture.id)).toBeUndefined()
      expect(getRemoteSyncAdapter(type)!.fetchLocal!(db, fixture.id)).toBeDefined()

      // The next start owes nothing that could delete the item.
      db.delete(syncQueue).run()
      recoverDirtyItems(db)
      expect(queuedOps(type, fixture.id)).not.toContain('delete')
    }
  )

  it.each(ACCEPTANCE_TYPES)(
    '%s: a true delete that was not followed by a re-create still replays (#2423)',
    (type) => {
      const fixture = FIXTURES[type]
      deleteWithRuntimeDown(type)

      startRuntime(type)
      seed(type)

      expect(queuedOps(type, fixture.id)).toEqual(['delete'])
      expect(pendingDeleteOf(fixture.id)).toBeDefined()
    }
  )

  it('a canvas folder tombstoned locally still replays its delete (#2423)', () => {
    db.insert(canvasFolders)
      .values({
        id: 'cvf_boards',
        vaultId: 'vault-1',
        path: 'boards',
        createdAt: 1,
        updatedAt: 1,
        clock: { [DEVICE]: 2 }
      })
      .run()
    const snapshot = JSON.stringify(
      db.select().from(canvasFolders).where(eq(canvasFolders.id, 'cvf_boards')).get()
    )
    enqueueLocalSyncDelete('canvas_folder', 'cvf_boards', snapshot)
    db.update(canvasFolders).set({ deletedAt: 2 }).where(eq(canvasFolders.id, 'cvf_boards')).run()

    initCanvasFolderSyncService(deps())
    recoverDirtyItems(db)

    expect(queuedOps('canvas_folder', 'cvf_boards')).toEqual(['delete'])
  })

  it('a note deleted as a note and back as a journal day is not deleted again (#2423)', () => {
    db.insert(noteMetadata)
      .values({
        id: 'j2026-04-16',
        path: 'j.md',
        title: 'j',
        createdAt: '2026-04-16T00:00:00Z',
        modifiedAt: '2026-04-16T00:00:00Z',
        clock: { [DEVICE]: 2 }
      })
      .run()
    enqueueLocalSyncDelete('note', 'j2026-04-16')
    db.update(noteMetadata)
      .set({ journalDate: '2026-04-16', clock: null })
      .where(eq(noteMetadata.id, 'j2026-04-16'))
      .run()

    initNoteSyncService(deps())
    recoverDirtyItems(db)

    expect(queuedOps('note', 'j2026-04-16')).toEqual([])
    expect(pendingDeleteOf('j2026-04-16')).toBeUndefined()
  })

  describe('a delete with no snapshot (#2423)', () => {
    const CALENDAR_EVENT_ID = `calendar_external_event:${SOURCE_ID}:evt-1`
    const BINDING_ID = 'calendar_binding:google:event:ev-1'

    const NO_SNAPSHOT = {
      tag_definition: {
        id: 'work',
        init: (d: ServiceDeps) => initTagDefinitionSyncService(d),
        insert: (clock: VectorClock | null) =>
          db.insert(tagDefinitions).values({ name: 'work', color: 'red', clock }).run()
      },
      folder_config: {
        id: 'Projects/Work',
        init: (d: ServiceDeps) => initFolderConfigSyncService(d),
        insert: (clock: VectorClock | null) =>
          db.insert(folderConfigs).values({ path: 'Projects/Work', icon: null, clock }).run()
      },
      tag_category: {
        id: 'cat-1',
        init: (d: ServiceDeps) => initTagCategorySyncService(d),
        insert: (clock: VectorClock | null) =>
          db.insert(tagCategories).values({ id: 'cat-1', name: 'Areas', clock }).run()
      },
      calendar_source: {
        id: 'google-calendar:work',
        init: (d: ServiceDeps) => initCalendarSourceSyncService(d),
        insert: (clock: VectorClock | null) =>
          db
            .insert(calendarSources)
            .values({
              id: 'google-calendar:work',
              provider: 'google',
              kind: 'calendar',
              remoteId: 'work',
              title: 'Work',
              clock
            })
            .run()
      },
      calendar_external_event: {
        id: CALENDAR_EVENT_ID,
        init: (d: ServiceDeps) => initCalendarExternalEventSyncService(d),
        insert: (clock: VectorClock | null) =>
          db
            .insert(calendarExternalEvents)
            .values({
              id: CALENDAR_EVENT_ID,
              sourceId: SOURCE_ID,
              remoteEventId: 'evt-1',
              title: 'Standup',
              startAt: '2026-04-16T09:00:00.000Z',
              clock
            })
            .run()
      },
      calendar_binding: {
        id: BINDING_ID,
        init: (d: ServiceDeps) => initCalendarBindingSyncService(d),
        insert: (clock: VectorClock | null) =>
          db
            .insert(calendarBindings)
            .values({
              id: BINDING_ID,
              sourceType: 'event',
              sourceId: 'ev-1',
              provider: 'google',
              remoteCalendarId: 'primary',
              remoteEventId: 'remote-1',
              ownershipMode: 'memry_managed',
              writebackMode: 'broad',
              clock
            })
            .run()
      }
    }
    type NoSnapshotType = keyof typeof NO_SNAPSHOT
    const NO_SNAPSHOT_TYPES = Object.keys(NO_SNAPSHOT) as NoSnapshotType[]

    const queuedDeleteClocks = (type: NoSnapshotType): VectorClock[] =>
      db
        .select({ payload: syncQueue.payload })
        .from(syncQueue)
        .where(and(eq(syncQueue.type, type), eq(syncQueue.operation, 'delete')))
        .all()
        .map((row) => (JSON.parse(row.payload) as { clock: VectorClock }).clock)

    it.each(NO_SNAPSHOT_TYPES)(
      '%s: with no local row, nothing is pushed and nothing is recorded',
      (type) => {
        NO_SNAPSHOT[type].init(deps())

        enqueueLocalSyncDelete(type, NO_SNAPSHOT[type].id)

        expect(queuedDeleteClocks(type)).toEqual([])
        expect(pendingDeleteOf(NO_SNAPSHOT[type].id)).toBeUndefined()
      }
    )

    it.each(NO_SNAPSHOT_TYPES)('%s: a clockless local row is not pushed with {dev:1}', (type) => {
      NO_SNAPSHOT[type].init(deps())
      NO_SNAPSHOT[type].insert(null)

      enqueueLocalSyncDelete(type, NO_SNAPSHOT[type].id)

      expect(queuedDeleteClocks(type)).toEqual([])
    })

    it.each(NO_SNAPSHOT_TYPES)('%s: a clocked local row ticks its own clock', (type) => {
      NO_SNAPSHOT[type].init(deps())
      NO_SNAPSHOT[type].insert({ [DEVICE]: 2, 'device-B': 5 })

      enqueueLocalSyncDelete(type, NO_SNAPSHOT[type].id)

      expect(queuedDeleteClocks(type)).toEqual([{ [DEVICE]: 3, 'device-B': 5 }])
    })
  })
})
