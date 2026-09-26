import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * #2409: a re-created deterministic id is minted with a clock that happens
 * strictly after its tombstone, for every re-creatable type and every way the
 * delete and the re-create can reach this device. Real migrated data and index
 * DBs, the real queue, the real sync services and handlers. The mocks are the
 * module-level database handles and the vault paths, which have no seam.
 */
let activeDb: unknown = null
let activeIndexDb: unknown = null

vi.mock('../database/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../database/client')>()),
  getDatabase: () => activeDb,
  getIndexDatabase: () => activeIndexDb
}))

vi.mock('../vault/journal', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../vault/journal')>()),
  getJournalPath: (date: string) => `/nonexistent/journals/${date}.md`
}))

import { z } from 'zod'
import { and, eq } from 'drizzle-orm'
import {
  asClientDb,
  createTestDataDb,
  createTestIndexDb,
  type TestDatabaseResult
} from '@tests/utils/test-db'
import type { VectorClock } from '@memry/contracts/sync-api'
import { SyncAdapterRegistry } from '@memry/sync-core'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { tagDefinitions } from '@memry/db-schema/schema/tag-definitions'
import { propertyDefinitions } from '@memry/db-schema/schema/notes-cache'
import { folderConfigs } from '@memry/db-schema/schema/folder-configs'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { syncQueue } from '@memry/db-schema/schema/sync-queue'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { compare } from '@memry/sync-client/vector-clock'
import { markSyncEligible, markSyncIneligible } from '@memry/sync-client/sync-eligibility'
import type { RecreatableItemType } from '@memry/sync-client/tombstone-clocks'
import { recordTombstoneClock } from '@memry/sync-client/tombstone-clocks'
import {
  initTagDefinitionSyncService,
  resetTagDefinitionSyncService
} from '@memry/sync-client/tag-definition-sync'
import {
  initPropertyDefinitionSyncService,
  resetPropertyDefinitionSyncService
} from '@memry/sync-client/property-definition-sync'
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
import { initJournalSyncService, resetJournalSyncService } from './journal-sync'
import { initNoteSyncService, resetNoteSyncService } from './note-sync'
import {
  enqueueLocalSyncCreate,
  enqueueLocalSyncDelete,
  enqueueLocalSyncUpdate
} from './local-mutations'
import { ItemApplier, type EmitToWindows } from './apply-item'
import { getRemoteSyncAdapter, resolveClockConflict } from './item-handlers'
import { runInitialSeed } from './initial-seed'

const DEVICE = 'device-A'
const PEER = 'device-B'
const STALE = 'device-C'
const JOURNAL_DATE = '2026-04-16'
const SOURCE_ID = 'google-calendar:primary'

interface ServiceDeps {
  db: DataDb
  queue: SyncQueueManager
  getDeviceId: () => string
}

/** One re-creatable type: its row, its delete arguments and its live service. */
interface Fixture {
  id: string
  /** Extra arguments of `enqueueLocalSyncCreate`/`Update` after the id. */
  extra: unknown[]
  insert(db: DataDb, clock: VectorClock | null): void
  remove(db: DataDb): void
  /** Extra arguments of `enqueueLocalSyncDelete`, read before the row goes. */
  deleteArgs(db: DataDb): unknown[]
  init(deps: ServiceDeps): void
  reset(): void
}

const rowSnapshot = (row: unknown): unknown[] => [JSON.stringify(row)]

const FIXTURES = {
  tag_definition: {
    id: 'work',
    extra: [],
    insert: (db, clock) =>
      db.insert(tagDefinitions).values({ name: 'work', color: 'red', clock }).run(),
    remove: (db) => db.delete(tagDefinitions).where(eq(tagDefinitions.name, 'work')).run(),
    deleteArgs: (db) =>
      rowSnapshot(db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()),
    init: (deps) => initTagDefinitionSyncService(deps),
    reset: resetTagDefinitionSyncService
  },
  property_definition: {
    id: 'Status',
    extra: [],
    insert: (db, clock) =>
      db.insert(propertyDefinitions).values({ name: 'Status', type: 'text', clock }).run(),
    remove: (db) =>
      db.delete(propertyDefinitions).where(eq(propertyDefinitions.name, 'Status')).run(),
    deleteArgs: (db) =>
      rowSnapshot(
        db.select().from(propertyDefinitions).where(eq(propertyDefinitions.name, 'Status')).get()
      ),
    init: (deps) => initPropertyDefinitionSyncService(deps),
    reset: resetPropertyDefinitionSyncService
  },
  folder_config: {
    id: 'Projects/Work',
    extra: [],
    insert: (db, clock) =>
      db.insert(folderConfigs).values({ path: 'Projects/Work', icon: null, clock }).run(),
    remove: (db) => db.delete(folderConfigs).where(eq(folderConfigs.path, 'Projects/Work')).run(),
    deleteArgs: (db) =>
      rowSnapshot(
        db.select().from(folderConfigs).where(eq(folderConfigs.path, 'Projects/Work')).get()
      ),
    init: (deps) => initFolderConfigSyncService(deps),
    reset: resetFolderConfigSyncService
  },
  canvas_folder: {
    id: 'cvf_boards',
    extra: [],
    insert: (db, clock) =>
      db
        .insert(canvasFolders)
        .values({
          id: 'cvf_boards',
          vaultId: 'vault-1',
          path: 'boards',
          createdAt: 1,
          updatedAt: 1,
          clock
        })
        .run(),
    remove: (db) => db.delete(canvasFolders).where(eq(canvasFolders.id, 'cvf_boards')).run(),
    deleteArgs: (db) =>
      rowSnapshot(db.select().from(canvasFolders).where(eq(canvasFolders.id, 'cvf_boards')).get()),
    init: (deps) => initCanvasFolderSyncService(deps),
    reset: resetCanvasFolderSyncService
  },
  bookmark: {
    id: 'bmk_note_n1',
    extra: [],
    insert: (db, clock) =>
      db
        .insert(bookmarks)
        .values({ id: 'bmk_note_n1', itemType: 'note', itemId: 'n1', clock })
        .run(),
    remove: (db) => db.delete(bookmarks).where(eq(bookmarks.id, 'bmk_note_n1')).run(),
    deleteArgs: (db) =>
      rowSnapshot(db.select().from(bookmarks).where(eq(bookmarks.id, 'bmk_note_n1')).get()),
    init: (deps) => initBookmarkSyncService(deps),
    reset: resetBookmarkSyncService
  },
  calendar_source: {
    id: 'google-calendar:work',
    extra: [],
    insert: (db, clock) =>
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
        .run(),
    remove: (db) =>
      db.delete(calendarSources).where(eq(calendarSources.id, 'google-calendar:work')).run(),
    deleteArgs: (db) =>
      rowSnapshot(
        db
          .select()
          .from(calendarSources)
          .where(eq(calendarSources.id, 'google-calendar:work'))
          .get()
      ),
    init: (deps) => initCalendarSourceSyncService(deps),
    reset: resetCalendarSourceSyncService
  },
  calendar_external_event: {
    id: `calendar_external_event:${SOURCE_ID}:evt-1`,
    extra: [],
    insert: (db, clock) =>
      db
        .insert(calendarExternalEvents)
        .values({
          id: `calendar_external_event:${SOURCE_ID}:evt-1`,
          sourceId: SOURCE_ID,
          remoteEventId: 'evt-1',
          title: 'Standup',
          startAt: '2026-04-16T09:00:00.000Z',
          clock
        })
        .run(),
    remove: (db) =>
      db
        .delete(calendarExternalEvents)
        .where(eq(calendarExternalEvents.id, `calendar_external_event:${SOURCE_ID}:evt-1`))
        .run(),
    deleteArgs: (db) =>
      rowSnapshot(
        db
          .select()
          .from(calendarExternalEvents)
          .where(eq(calendarExternalEvents.id, `calendar_external_event:${SOURCE_ID}:evt-1`))
          .get()
      ),
    init: (deps) => initCalendarExternalEventSyncService(deps),
    reset: resetCalendarExternalEventSyncService
  },
  calendar_binding: {
    id: 'calendar_binding:google:event:ev-1',
    extra: [],
    insert: (db, clock) =>
      db
        .insert(calendarBindings)
        .values({
          id: 'calendar_binding:google:event:ev-1',
          sourceType: 'event',
          sourceId: 'ev-1',
          provider: 'google',
          remoteCalendarId: 'primary',
          remoteEventId: 'remote-1',
          ownershipMode: 'memry_managed',
          writebackMode: 'broad',
          clock
        })
        .run(),
    remove: (db) =>
      db
        .delete(calendarBindings)
        .where(eq(calendarBindings.id, 'calendar_binding:google:event:ev-1'))
        .run(),
    deleteArgs: (db) =>
      rowSnapshot(
        db
          .select()
          .from(calendarBindings)
          .where(eq(calendarBindings.id, 'calendar_binding:google:event:ev-1'))
          .get()
      ),
    init: (deps) => initCalendarBindingSyncService(deps),
    reset: resetCalendarBindingSyncService
  },
  journal: {
    id: `j${JOURNAL_DATE}`,
    extra: [JOURNAL_DATE],
    insert: (db, clock) =>
      db
        .insert(noteMetadata)
        .values({
          id: `j${JOURNAL_DATE}`,
          path: `journals/${JOURNAL_DATE}.md`,
          title: JOURNAL_DATE,
          journalDate: JOURNAL_DATE,
          createdAt: '2026-04-16T00:00:00Z',
          modifiedAt: '2026-04-16T00:00:00Z',
          clock
        })
        .run(),
    remove: (db) =>
      db
        .delete(noteMetadata)
        .where(eq(noteMetadata.id, `j${JOURNAL_DATE}`))
        .run(),
    deleteArgs: () => [JOURNAL_DATE],
    init: (deps) => initJournalSyncService(deps),
    reset: resetJournalSyncService
  },
  note: {
    id: 'note-restored',
    extra: [],
    insert: (db, clock) =>
      db
        .insert(noteMetadata)
        .values({
          id: 'note-restored',
          path: 'note-restored.pdf',
          title: 'Restored',
          fileType: 'pdf',
          createdAt: '2026-04-16T00:00:00Z',
          modifiedAt: '2026-04-16T00:00:00Z',
          clock
        })
        .run(),
    remove: (db) => db.delete(noteMetadata).where(eq(noteMetadata.id, 'note-restored')).run(),
    deleteArgs: () => [],
    init: (deps) => initNoteSyncService(deps),
    reset: resetNoteSyncService
  }
} satisfies Record<RecreatableItemType, Fixture>

const TYPES = Object.keys(FIXTURES) as RecreatableItemType[]

describe('re-create clock seeding (#2409)', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult
  let db: DataDb
  let queue: SyncQueueManager

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
    db = asClientDb(dataDb.db)
    activeDb = db
    activeIndexDb = indexDb.db
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
    for (const type of TYPES) FIXTURES[type].reset()
    markSyncIneligible()
    activeDb = null
    activeIndexDb = null
    dataDb.close()
    indexDb.close()
  })

  const startService = (type: RecreatableItemType): void => {
    FIXTURES[type].init({ db, queue, getDeviceId: () => DEVICE })
  }

  const queuedClock = (type: RecreatableItemType, operation: string): VectorClock => {
    const row = db
      .select()
      .from(syncQueue)
      .where(
        and(
          eq(syncQueue.type, type),
          eq(syncQueue.itemId, FIXTURES[type].id),
          eq(syncQueue.operation, operation)
        )
      )
      .get()
    expect(row, `${type}: a queued ${operation}`).toBeDefined()
    return (JSON.parse(row!.payload) as { clock: VectorClock }).clock
  }

  /** The delete reached the server: its queue row is gone. */
  const ackQueue = (): void => {
    db.delete(syncQueue).run()
  }

  /** A remote delete through the real ItemApplier; the stub adapter stands in for each handler's row delete. */
  const applyRemoteDelete = (type: RecreatableItemType, clock: VectorClock): void => {
    const registry = new SyncAdapterRegistry<typeof db, EmitToWindows>([
      {
        type,
        kind: 'record',
        remote: {
          type,
          schema: z.unknown(),
          applyRemoteMutation: ({ db: pageDb }) => {
            FIXTURES[type].remove(pageDb)
            return 'applied'
          }
        }
      }
    ])
    const result = new ItemApplier(db, vi.fn(), registry).apply({
      itemId: FIXTURES[type].id,
      type,
      operation: 'delete',
      content: new Uint8Array(),
      clock
    })
    expect(result).toBe('applied')
  }

  it.each(TYPES)('%s: a live re-create after a local delete ticks past the delete', (type) => {
    const fixture = FIXTURES[type]
    startService(type)
    fixture.insert(db, { [DEVICE]: 2 })

    enqueueLocalSyncDelete(type, fixture.id, ...fixture.deleteArgs(db))
    fixture.remove(db)
    const deleteClock = queuedClock(type, 'delete')
    ackQueue()

    fixture.insert(db, null)
    enqueueLocalSyncCreate(type, fixture.id, ...fixture.extra)

    expect(compare(queuedClock(type, 'create'), deleteClock)).toBe('after')
  })

  it.each(TYPES)('%s: a live re-create after a remote delete ticks past the tombstone', (type) => {
    const fixture = FIXTURES[type]
    startService(type)
    fixture.insert(db, { [DEVICE]: 1 })
    const tombstone = { [DEVICE]: 1, [PEER]: 3 }

    applyRemoteDelete(type, tombstone)
    fixture.insert(db, null)
    enqueueLocalSyncCreate(type, fixture.id, ...fixture.extra)

    expect(compare(queuedClock(type, 'create'), tombstone)).toBe('after')
  })

  it.each(TYPES)(
    '%s: with the runtime down, the start-up seed of a clockless re-create ticks past the delete',
    (type) => {
      const fixture = FIXTURES[type]
      fixture.insert(db, { [DEVICE]: 2 })

      enqueueLocalSyncDelete(type, fixture.id, ...fixture.deleteArgs(db))
      fixture.remove(db)
      fixture.insert(db, null)
      runInitialSeed({ db, queue, deviceId: DEVICE, adapters: [getRemoteSyncAdapter(type)!] })

      expect(compare(queuedClock(type, 'create'), { [DEVICE]: 3 })).toBe('after')
    }
  )

  it('property_definition: an update over a clockless row is seeded', () => {
    const fixture = FIXTURES.property_definition
    startService('property_definition')
    fixture.insert(db, { [DEVICE]: 1 })
    const tombstone = { [DEVICE]: 1, [PEER]: 3 }

    applyRemoteDelete('property_definition', tombstone)
    fixture.insert(db, null)
    enqueueLocalSyncUpdate('property_definition', fixture.id)

    expect(compare(queuedClock('property_definition', 'update'), tombstone)).toBe('after')
  })

  describe('a stale device', () => {
    // Device C last saw {A:1}; B deleted at {A:1, B:3}; A re-created afterwards.
    const tombstone = { [DEVICE]: 1, [PEER]: 3 }

    const reCreate = (): VectorClock => {
      startService('journal')
      FIXTURES.journal.insert(db, { [DEVICE]: 1 })
      applyRemoteDelete('journal', tombstone)
      FIXTURES.journal.insert(db, null)
      enqueueLocalSyncCreate('journal', FIXTURES.journal.id, JOURNAL_DATE)
      return queuedClock('journal', 'create')
    }

    it('an unchanged pre-delete version never applies over the re-create', () => {
      const recreated = reCreate()
      expect(resolveClockConflict(recreated, { [DEVICE]: 1 }).action).toBe('skip')
    })

    it('an edited pre-delete version resolves as a merge, never as a dominating apply', () => {
      const recreated = reCreate()
      expect(resolveClockConflict(recreated, { [DEVICE]: 1, [STALE]: 1 }).action).toBe('merge')
    })
  })

  it("the device's own late tombstone does not delete its re-create", () => {
    const fixture = FIXTURES.tag_definition
    startService('tag_definition')
    fixture.insert(db, { [DEVICE]: 2 })
    enqueueLocalSyncDelete('tag_definition', fixture.id, ...fixture.deleteArgs(db))
    fixture.remove(db)
    const ownTombstone = queuedClock('tag_definition', 'delete')
    ackQueue()
    fixture.insert(db, null)
    enqueueLocalSyncCreate('tag_definition', fixture.id)

    const result = new ItemApplier(db, vi.fn()).apply({
      itemId: fixture.id,
      type: 'tag_definition',
      operation: 'delete',
      content: new Uint8Array(),
      clock: ownTombstone
    })

    expect(result).toBe('skipped')
    expect(
      db.select().from(tagDefinitions).where(eq(tagDefinitions.name, 'work')).get()
    ).toBeDefined()
  })

  describe("old rows (no recorded tombstone) keep today's clocks", () => {
    it.each(TYPES)('%s: a create with no recorded delete pushes the fresh clock', (type) => {
      const fixture = FIXTURES[type]
      startService(type)
      fixture.insert(db, null)

      enqueueLocalSyncCreate(type, fixture.id, ...fixture.extra)

      expect(queuedClock(type, 'create')).toEqual({ [DEVICE]: 1 })
    })

    it('an update of a clocked row ignores a recorded tombstone', () => {
      startService('tag_definition')
      FIXTURES.tag_definition.insert(db, { [DEVICE]: 5 })
      recordTombstoneClock(db, 'tag_definition', 'work', { [PEER]: 9 })

      enqueueLocalSyncUpdate('tag_definition', 'work')

      expect(queuedClock('tag_definition', 'update')).toEqual({ [DEVICE]: 6 })
    })
  })
})
