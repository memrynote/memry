import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import { savedFilters } from '@memry/db-schema/schema/settings'
import { bookmarks } from '@memry/db-schema/schema/bookmarks'
import { templates } from '@memry/db-schema/schema/templates'
import { homePages } from '@memry/db-schema/schema/home-pages'
import { customIcons } from '@memry/db-schema/schema/custom-icons'
import { reminders } from '@memry/db-schema/schema/reminders'
import { canvasFolders } from '@memry/db-schema/schema/canvas-folder'
import { taskActivity } from '@memry/db-schema/schema/task-activity'
import { RECORD_SYNC_ITEM_TYPES, type RecordSyncItemType } from '@memry/contracts/sync-api'
import type { DataDb } from '../database/client'
import { incrementNoteClockOffline } from '@memry/sync-client/offline-clock'
import { SyncQueueManager } from '@memry/sync-client/queue'
import { initTaskSyncService, resetTaskSyncService } from '@memry/sync-client/task-sync'
import { initProjectSyncService, resetProjectSyncService } from '@memry/sync-client/project-sync'
import { initInboxSyncService, resetInboxSyncService } from '@memry/sync-client/inbox-sync'
import { initFilterSyncService, resetFilterSyncService } from '@memry/sync-client/filter-sync'
import { initBookmarkSyncService, resetBookmarkSyncService } from '@memry/sync-client/bookmark-sync'
import { initTemplateSyncService, resetTemplateSyncService } from '@memry/sync-client/template-sync'
import {
  initHomePageSyncService,
  resetHomePageSyncService
} from '@memry/sync-client/home-page-sync'
import {
  initCustomIconSyncService,
  resetCustomIconSyncService
} from '@memry/sync-client/custom-icon-sync'
import { initReminderSyncService, resetReminderSyncService } from '@memry/sync-client/reminder-sync'
import {
  initCanvasFolderSyncService,
  resetCanvasFolderSyncService
} from '@memry/sync-client/canvas-folder-sync'
import {
  initTaskActivitySyncService,
  resetTaskActivitySyncService
} from '@memry/sync-client/task-activity-sync'
import { syncIntents } from '@memry/db-schema/schema/sync-intents'
import { trackMainEvent } from '../telemetry/track'
import { DIRTY_RECOVERY, recoverDirtyItems } from './dirty-recovery'

const TEST_PROJECT = {
  id: 'proj-1',
  name: 'Test Project',
  color: '#000',
  position: 0,
  isInbox: false,
  modifiedAt: '2026-01-01T00:00:00Z',
  syncedAt: '2026-01-01T00:00:00Z'
}

describe('dirty-recovery', () => {
  let testDb: TestDatabaseResult
  let queue: SyncQueueManager
  let db: DataDb

  beforeEach(() => {
    testDb = createTestDataDb()
    db = asClientDb(testDb.db)
    queue = new SyncQueueManager(db)
    initTaskSyncService({ queue, db, getDeviceId: () => 'device-A' })
    initProjectSyncService({ queue, db, getDeviceId: () => 'device-A' })

    db.insert(projects).values(TEST_PROJECT).run()
  })

  afterEach(() => {
    resetTaskSyncService()
    resetProjectSyncService()
    testDb.close()
  })

  it('recovers tasks modified since last sync', () => {
    // #given — task synced at t=1, modified at t=2
    db.insert(tasks)
      .values({
        id: 'task-1',
        projectId: 'proj-1',
        title: 'Original',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    expect(queue.getPendingCount()).toBe(1)

    const item = queue.peek(1)[0]
    expect(item?.itemId).toBe('task-1')
    expect(item?.operation).toBe('update')
  })

  it('recovers tasks created while signed out (syncedAt = null)', () => {
    // #given — task with no syncedAt
    db.insert(tasks)
      .values({
        id: 'task-new',
        projectId: 'proj-1',
        title: 'Created offline',
        priority: 0,
        position: 0,
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    const item = queue.peek(1)[0]
    expect(item?.itemId).toBe('task-new')
    expect(item?.operation).toBe('create')
  })

  it('skips tasks already synced and unmodified', () => {
    // #given — task where syncedAt >= modifiedAt
    db.insert(tasks)
      .values({
        id: 'task-clean',
        projectId: 'proj-1',
        title: 'Clean',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(0)
    expect(queue.getPendingCount()).toBe(0)
  })

  it('preserves existing clocks for recovered tasks without offline marker', () => {
    // #given — dirty task whose clock was already advanced at write time
    db.insert(tasks)
      .values({
        id: 'task-stale',
        projectId: 'proj-1',
        title: 'Stale',
        priority: 0,
        position: 0,
        clock: { 'old-device': 1 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    recoverDirtyItems(db)

    // #then — recovery should not mutate non-offline clocks
    const task = db.select().from(tasks).where(eq(tasks.id, 'task-stale')).get()
    const clock = task?.clock as Record<string, number>
    expect(clock['old-device']).toBe(1)
    expect(clock['device-A']).toBeUndefined()
  })

  it('does not synthesize field clocks for recovered tasks without offline marker', () => {
    // #given
    db.insert(tasks)
      .values({
        id: 'task-nofc',
        projectId: 'proj-1',
        title: 'No field clocks',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    // #when
    recoverDirtyItems(db)

    // #then — recovery should not inflate field-level metadata
    const task = db.select().from(tasks).where(eq(tasks.id, 'task-nofc')).get()
    expect(task?.fieldClocks ?? null).toBeNull()
  })

  it('rebinds offline task clocks to current device during recovery', () => {
    db.insert(tasks)
      .values({
        id: 'task-offline',
        projectId: 'proj-1',
        title: 'Offline dirty',
        priority: 0,
        position: 0,
        clock: { 'old-device': 1, _offline: 1 },
        fieldClocks: {
          title: { 'old-device': 1 },
          statusId: { 'old-device': 1, _offline: 1 },
          dueDate: { 'old-device': 1 }
        },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    recoverDirtyItems(db)

    const queued = queue.peek(1)[0]
    expect(queued?.operation).toBe('update')
    const payload = queued ? (JSON.parse(queued.payload) as Record<string, unknown>) : null
    const payloadFieldClocks = payload?.fieldClocks as
      Record<string, Record<string, number>> | undefined
    expect(payload?.clock).toEqual({ 'old-device': 1, 'device-A': 1 })
    expect(payloadFieldClocks?.statusId).toEqual({ 'old-device': 1, 'device-A': 1 })
    expect(payloadFieldClocks?.title).toEqual({ 'old-device': 1 })

    const task = db.select().from(tasks).where(eq(tasks.id, 'task-offline')).get()
    const clock = task?.clock as Record<string, number>
    const fc = task?.fieldClocks as Record<string, Record<string, number>>
    expect(clock._offline).toBeUndefined()
    expect(fc.statusId._offline).toBeUndefined()
  })

  it('rebinds offline clocks on the never-synced create path too', () => {
    // The shape a task created and then edited while signed out actually has:
    // `syncedAt` null, so recovery routes it to `enqueueCreate`, which only
    // adds the real device's tick. `_offline` is a device id every install
    // claims, so letting it reach the wire makes two peers' clocks compare
    // equal for edits that are genuinely concurrent (#2179).
    db.insert(tasks)
      .values({
        id: 'task-offline-create',
        projectId: 'proj-1',
        title: 'Created offline',
        priority: 0,
        position: 0,
        clock: { _offline: 2 },
        fieldClocks: {
          title: { _offline: 1 },
          statusId: {},
          dueDate: {}
        },
        syncedAt: null,
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    recoverDirtyItems(db)

    const queued = queue.peek(1)[0]
    expect(queued?.operation).toBe('create')
    const payload = queued ? (JSON.parse(queued.payload) as Record<string, unknown>) : null
    const payloadFieldClocks = payload?.fieldClocks as
      Record<string, Record<string, number>> | undefined
    expect(payload?.clock).toEqual({ 'device-A': 3 })
    expect(payloadFieldClocks?.title).toEqual({ 'device-A': 2 })

    const task = db.select().from(tasks).where(eq(tasks.id, 'task-offline-create')).get()
    expect((task?.clock as Record<string, number>)._offline).toBeUndefined()
    const fc = task?.fieldClocks as Record<string, Record<string, number>>
    expect(fc.title._offline).toBeUndefined()
  })

  it('recovers dirty projects', () => {
    // #given — project modified after last sync
    db.update(projects)
      .set({
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.projects).toBe(1)
    expect(queue.getPendingCount()).toBe(1)
  })

  it('recovers both tasks and projects in one call', () => {
    // #given
    db.insert(tasks)
      .values({
        id: 'task-dirty',
        projectId: 'proj-1',
        title: 'Dirty task',
        priority: 0,
        position: 0,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .run()

    db.update(projects)
      .set({
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(1)
    expect(result.projects).toBe(1)
    expect(queue.getPendingCount()).toBe(2)
  })

  it('returns zero counts when nothing is dirty', () => {
    // #given — only clean, synced project exists (no tasks)
    db.update(projects)
      .set({
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })
      .where(eq(projects.id, 'proj-1'))
      .run()

    // #when
    const result = recoverDirtyItems(db)

    // #then
    expect(result.tasks).toBe(0)
    expect(result.projects).toBe(0)
  })

  // #2301: the instrument the P4.2 merge gate reads. Leftover intents are
  // replayed before the sweep; a dirty row that then has a queue row is owed
  // and on its way, one without is a local edit nothing would have pushed.
  describe('residual rows telemetry (#2301)', () => {
    function insertDirtyTask(id: string): void {
      db.insert(tasks)
        .values({
          id,
          projectId: 'proj-1',
          title: id,
          priority: 0,
          position: 0,
          syncedAt: '2026-01-01T00:00:00Z',
          modifiedAt: '2026-01-02T00:00:00Z'
        })
        .run()
    }

    beforeEach(() => {
      vi.mocked(trackMainEvent).mockClear()
    })

    it('reports per type the dirty rows that had no queue row and no intent', () => {
      insertDirtyTask('task-orphan')
      insertDirtyTask('task-queued')
      insertDirtyTask('task-intent')
      queue.enqueue({ type: 'task', itemId: 'task-queued', operation: 'update', payload: '{}' })
      db.insert(syncIntents)
        .values({ type: 'task', itemId: 'task-intent', op: 'update', createdAt: new Date() })
        .run()

      recoverDirtyItems(db)

      // The leftover intent is replayed first, so its row is owed, not residual.
      expect(db.select().from(syncIntents).all()).toEqual([])
      expect(vi.mocked(trackMainEvent).mock.calls).toEqual([
        [
          'sync_run_completed',
          {
            surface: 'sync',
            action: 'sync_intents_replayed',
            result: 'success',
            metrics: { itemCount: 1, resultCount: 1, retryCount: 0, value: 0 }
          }
        ],
        [
          'sync_run_completed',
          {
            surface: 'sync',
            action: 'dirty_recovery_residual',
            objectType: 'task',
            result: 'success',
            metrics: { itemCount: 1, resultCount: 2 }
          }
        ]
      ])
    })

    // #2301 review B-1: a row whose intent failed to replay still carries the
    // pre-edit clock. The sweep must leave it to the intent; re-pushing it at
    // that clock is refused by the server as a replay and marks it synced.
    it('does not queue a row at its stale clock when its intent failed to replay', () => {
      db.insert(tasks)
        .values({
          id: 'task-1',
          projectId: 'proj-1',
          title: 'Edited',
          priority: 0,
          position: 0,
          clock: { 'device-A': 3 },
          syncedAt: '2026-01-01T00:00:00Z',
          modifiedAt: '2026-01-02T00:00:00Z'
        })
        .run()
      db.insert(syncIntents)
        .values({
          type: 'task',
          itemId: 'task-1',
          op: 'update',
          args: '[["title"]]',
          createdAt: new Date()
        })
        .run()
      vi.spyOn(queue, 'enqueue').mockImplementationOnce(() => {
        throw new Error('queue broke')
      })

      recoverDirtyItems(db)

      expect(queue.getSize()).toBe(0)
      expect(db.select().from(syncIntents).all()).toMatchObject([
        { itemId: 'task-1', attempts: 1, lastError: 'queue broke' }
      ])
      vi.restoreAllMocks()
    })

    // #2301 review A-6/B-7: a replayed create is stamped once, not again by
    // the sweep's never-synced arm.
    it('stamps a replayed never-synced create once', () => {
      db.insert(tasks)
        .values({
          id: 'task-new',
          projectId: 'proj-1',
          title: 'New',
          priority: 0,
          position: 0,
          modifiedAt: '2026-01-02T00:00:00Z'
        })
        .run()
      db.insert(syncIntents)
        .values({ type: 'task', itemId: 'task-new', op: 'create', createdAt: new Date() })
        .run()

      recoverDirtyItems(db)

      expect(db.select().from(tasks).where(eq(tasks.id, 'task-new')).get()?.clock).toEqual({
        'device-A': 1
      })
      expect(queue.peek(10)).toMatchObject([{ itemId: 'task-new', operation: 'create' }])
    })

    it('reports nothing when every dirty row is already owed', () => {
      insertDirtyTask('task-queued')
      queue.enqueue({ type: 'task', itemId: 'task-queued', operation: 'update', payload: '{}' })

      recoverDirtyItems(db)

      expect(trackMainEvent).not.toHaveBeenCalled()
    })
  })

  describe('notes', () => {
    const recovered: string[] = []
    const noteAdapters = {
      getLocal: (type: string) =>
        type === 'note' ? { enqueueRecoveredUpdate: (id: string) => recovered.push(id) } : undefined
    } as unknown as Parameters<typeof recoverDirtyItems>[1]

    const insertNote = (values: Record<string, unknown>): void => {
      db.insert(noteMetadata)
        .values({
          path: `notes/${values.id as string}.md`,
          title: 'A note',
          createdAt: '2026-01-01T00:00:00Z',
          ...values
        } as never)
        .run()
    }

    beforeEach(() => {
      recovered.length = 0
    })

    it('recovers a synced note whose local change never reached the server', () => {
      // #given — the push that carried the rename was dropped, so the note is
      // modified after its last confirmed sync but nothing is queued
      insertNote({
        id: 'note-diverged',
        clock: { 'device-A': 2 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })

      // #when
      const result = recoverDirtyItems(db, noteAdapters)

      // #then
      expect(result.notes).toBe(1)
      expect(recovered).toEqual(['note-diverged'])
    })

    it('recovers a synced note that has never been stamped as pushed', () => {
      // #given — legacy rows carry no syncedAt at all
      insertNote({
        id: 'note-legacy',
        clock: { 'device-A': 1 },
        syncedAt: null,
        modifiedAt: '2026-01-02T00:00:00Z'
      })

      // #when
      const result = recoverDirtyItems(db, noteAdapters)

      // #then
      expect(result.notes).toBe(1)
      expect(recovered).toEqual(['note-legacy'])
    })

    it('leaves clean, local-only, journal and never-synced notes alone', () => {
      // clean: already stamped after its last edit
      insertNote({
        id: 'note-clean',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-03T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // local-only: must never be pushed
      insertNote({
        id: 'note-local',
        clock: { 'device-A': 1 },
        localOnly: true,
        syncPolicy: 'local-only',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // journal: owned by the journal sync service
      insertNote({
        id: 'note-journal',
        clock: { 'device-A': 1 },
        journalDate: '2026-01-02',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // never synced: seedUnclockedNotes owns clock-less notes
      insertNote({ id: 'note-unclocked', modifiedAt: '2026-01-02T00:00:00Z' })

      // #when
      const result = recoverDirtyItems(db, noteAdapters)

      // #then
      expect(result.notes).toBe(0)
      expect(recovered).toEqual([])
    })

    it('re-pushes a note whose update was enqueued while the sync service was down', () => {
      // #given — a note the server has already confirmed, and a registered
      // device (uploads only happen signed in)
      db.insert(syncDevices)
        .values({
          id: 'device-A',
          name: 'Test device',
          platform: 'darwin',
          appVersion: '1.0.0',
          linkedAt: new Date('2026-01-01T00:00:00Z'),
          isCurrentDevice: true,
          signingPublicKey: 'pk'
        })
        .run()
      insertNote({
        id: 'note-attachment',
        clock: { 'device-A': 2 },
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })

      // The attachment reference write itself never touches modifiedAt, so
      // without the fallback this note stays invisible to recovery forever.
      expect(recoverDirtyItems(db, noteAdapters).notes).toBe(0)

      // #when — the upload completes after the runtime was torn down, so the
      // note adapter's offline fallback is all that runs
      incrementNoteClockOffline(db, 'note-attachment')

      // #then — the next runtime start pushes it, at a clock the server cannot
      // dismiss as a replay of what it already has
      const result = recoverDirtyItems(db, noteAdapters)
      expect(result.notes).toBe(1)
      expect(recovered).toEqual(['note-attachment'])

      const row = db.select().from(noteMetadata).where(eq(noteMetadata.id, 'note-attachment')).get()
      expect(row?.clock).toEqual({ 'device-A': 3 })
    })
  })

  // Journals share `note_metadata` with notes but are pushed by their own sync
  // service, so the note sweep excludes them by construction (`journalDate IS
  // NULL`). Without an arm of their own, a journal metadata update raised while
  // the runtime was down had nothing left to re-push it: no queue row, no dirty
  // marker, no sweep.
  describe('journals', () => {
    const recovered: string[] = []
    const journalAdapters = {
      getLocal: (type: string) =>
        type === 'journal'
          ? { enqueueRecoveredUpdate: (id: string) => recovered.push(id) }
          : undefined
    } as unknown as Parameters<typeof recoverDirtyItems>[1]

    const insertJournal = (values: Record<string, unknown>): void => {
      db.insert(noteMetadata)
        .values({
          path: `journal/${values.id as string}.md`,
          title: 'A journal',
          journalDate: '2026-01-02',
          createdAt: '2026-01-01T00:00:00Z',
          ...values
        } as never)
        .run()
    }

    beforeEach(() => {
      recovered.length = 0
    })

    it('recovers a synced journal whose local change never reached the server', () => {
      // #given — the push that carried the tag edit was dropped, so the journal
      // is modified after its last confirmed sync but nothing is queued
      insertJournal({
        id: 'journal-diverged',
        clock: { 'device-A': 2 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })

      // #when
      const result = recoverDirtyItems(db, journalAdapters)

      // #then
      expect(result.journals).toBe(1)
      expect(recovered).toEqual(['journal-diverged'])
    })

    it('leaves clean, local-only and clock-less journals — and plain notes — alone', () => {
      // clean: already stamped after its last edit
      insertJournal({
        id: 'journal-clean',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-03T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // local-only: must never be pushed
      insertJournal({
        id: 'journal-local',
        clock: { 'device-A': 1 },
        localOnly: true,
        syncPolicy: 'local-only',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // clock-less: journalHandler.seedUnclocked owns the first push
      insertJournal({ id: 'journal-unclocked', modifiedAt: '2026-01-02T00:00:00Z' })
      // a plain note must not be dragged in by the journal arm
      db.insert(noteMetadata)
        .values({
          id: 'plain-note',
          path: 'notes/plain-note.md',
          title: 'A note',
          createdAt: '2026-01-01T00:00:00Z',
          clock: { 'device-A': 1 },
          syncedAt: null,
          modifiedAt: '2026-01-02T00:00:00Z'
        } as never)
        .run()

      // #when
      const result = recoverDirtyItems(db, journalAdapters)

      // #then
      expect(result.journals).toBe(0)
      expect(recovered).toEqual([])
    })

    it('re-pushes a journal whose update was enqueued while the sync service was down', () => {
      // #given — a journal the server has already confirmed, and a registered
      // device (metadata edits only sync while signed in)
      db.insert(syncDevices)
        .values({
          id: 'device-A',
          name: 'Test device',
          platform: 'darwin',
          appVersion: '1.0.0',
          linkedAt: new Date('2026-01-01T00:00:00Z'),
          isCurrentDevice: true,
          signingPublicKey: 'pk'
        })
        .run()
      insertJournal({
        id: 'journal-tagged',
        clock: { 'device-A': 2 },
        syncedAt: '2026-01-02T00:00:00Z',
        modifiedAt: '2026-01-01T00:00:00Z'
      })

      // A metadata-only write never touches modifiedAt, so without the fallback
      // this journal stays invisible to recovery forever.
      expect(recoverDirtyItems(db, journalAdapters).journals).toBe(0)

      // #when — the property edit lands after the runtime was torn down, so the
      // journal adapter's offline fallback is all that runs
      incrementNoteClockOffline(db, 'journal-tagged')

      // #then — the next runtime start pushes it, at a clock the server cannot
      // dismiss as a replay of what it already has
      const result = recoverDirtyItems(db, journalAdapters)
      expect(result.journals).toBe(1)
      expect(recovered).toEqual(['journal-tagged'])

      const row = db.select().from(noteMetadata).where(eq(noteMetadata.id, 'journal-tagged')).get()
      expect(row?.clock).toEqual({ 'device-A': 3 })
    })
  })

  // Builds before the #1159 fix filed items without enqueueing anything, and
  // nothing else on an existing install ever touches those rows again:
  // seedUnclocked only takes clock-less rows, the manifest check is
  // presence-based and the item is present, and filing.ts refuses to re-file an
  // item that already has a filedAt. This arm is the only thing that heals them.
  describe('inbox', () => {
    // Deliberately the real InboxSyncService and the real queue, not a stub:
    // the thing under test is that a queue row is actually produced *and* that
    // the vector clock advances past what the server already holds. A fake
    // adapter would assert neither.
    const insertItem = (values: Record<string, unknown>): void => {
      db.insert(inboxItems)
        .values({
          type: 'link',
          title: 'A capture',
          createdAt: '2026-01-01T00:00:00Z',
          ...values
        } as never)
        .run()
    }

    beforeEach(() => {
      initInboxSyncService({ queue, db, getDeviceId: () => 'device-A' })
    })

    afterEach(() => {
      resetInboxSyncService()
    })

    it('recovers an item filed before the fix, at a clock the server cannot dismiss', () => {
      // #given — captured and pushed, then filed by a pre-fix build: filedAt
      // and modifiedAt moved, the clock and syncedAt did not
      insertItem({
        id: 'inbox-filed',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z',
        filedAt: '2026-01-02T00:00:00Z',
        filedTo: 'notes/Filed.md',
        filedAction: 'folder'
      })

      // #when
      const result = recoverDirtyItems(db)

      // #then — one real queue row carrying the filed state
      expect(result.inbox).toBe(1)
      expect(queue.getPendingCount()).toBe(1)

      const queued = queue.peek(1)[0]
      expect(queued?.type).toBe('inbox')
      expect(queued?.itemId).toBe('inbox-filed')
      expect(queued?.operation).toBe('update')

      const payload = JSON.parse(queued?.payload ?? '{}') as Record<string, unknown>
      expect(payload.filedAt).toBe('2026-01-02T00:00:00Z')
      expect(payload.filedTo).toBe('notes/Filed.md')
      // The clock MUST advance. Replaying {device-A: 1} — the clock the server
      // already has — loses to any peer that has moved on since, and the filing
      // would be dropped a second time.
      expect(payload.clock).toEqual({ 'device-A': 2 })

      const row = db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-filed')).get()
      expect(row?.clock).toEqual({ 'device-A': 2 })
    })

    it('leaves clean, local-only and clock-less items alone', () => {
      // clean: stamped after its last write — the whole inbox must not re-push
      insertItem({
        id: 'inbox-clean',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-03T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // local-only: never leaves this device
      insertItem({
        id: 'inbox-local',
        clock: { 'device-A': 1 },
        localOnly: true,
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z'
      })
      // clock-less: inboxHandler.seedUnclocked owns the first push
      insertItem({ id: 'inbox-unclocked', modifiedAt: '2026-01-02T00:00:00Z' })

      // #when
      const result = recoverDirtyItems(db)

      // #then
      expect(result.inbox).toBe(0)
      expect(queue.getPendingCount()).toBe(0)
    })

    it('recovers an item the server confirmed but never stamped as pushed', () => {
      // #given — legacy rows carry no syncedAt at all
      insertItem({
        id: 'inbox-legacy',
        clock: { 'device-A': 1 },
        syncedAt: null,
        modifiedAt: '2026-01-02T00:00:00Z'
      })

      // #when / #then
      expect(recoverDirtyItems(db).inbox).toBe(1)
    })

    it('rebinds an offline tick instead of putting _offline on the wire (#2286)', () => {
      // #given — captured while signed out: incrementInboxClockOffline parked
      // the tick under `_offline` and wrote no queue row
      insertItem({
        id: 'inbox-offline',
        clock: { 'device-A': 1, _offline: 1 },
        syncedAt: null,
        modifiedAt: '2026-01-02T00:00:00Z'
      })

      // #when
      recoverDirtyItems(db)

      // #then — still the bumping update this arm always used, rebound first
      const queued = queue.peek(1)[0]
      expect(queued?.operation).toBe('update')
      expect(queued?.payload).not.toContain('_offline')
      expect((JSON.parse(queued?.payload ?? '{}') as { clock?: unknown }).clock).toEqual({
        'device-A': 3
      })
      const row = db.select().from(inboxItems).where(eq(inboxItems.id, 'inbox-offline')).get()
      expect(row?.clock).toEqual({ 'device-A': 3 })
    })

    it('stops firing once the push is stamped, and never queues a row twice', () => {
      insertItem({
        id: 'inbox-filed',
        clock: { 'device-A': 1 },
        syncedAt: '2026-01-01T00:00:00Z',
        modifiedAt: '2026-01-02T00:00:00Z',
        filedAt: '2026-01-02T00:00:00Z'
      })

      // #when — two launches before the push drains
      expect(recoverDirtyItems(db).inbox).toBe(1)
      expect(recoverDirtyItems(db).inbox).toBe(1)

      // #then — the queue deduplicates on itemId+type+operation
      expect(queue.getPendingCount()).toBe(1)

      // #when — the push lands and markPushSynced stamps the row
      db.update(inboxItems)
        .set({ syncedAt: '2026-01-03T00:00:00Z' })
        .where(eq(inboxItems.id, 'inbox-filed'))
        .run()

      // #then — the sweep goes quiet for good
      expect(recoverDirtyItems(db).inbox).toBe(0)
    })
  })

  it('pushes a never-synced project as a create with no _offline key on the wire (#2286)', () => {
    db.update(projects)
      .set({ clock: { _offline: 2 }, syncedAt: null })
      .where(eq(projects.id, 'proj-1'))
      .run()

    recoverDirtyItems(db)

    const queued = queue.peek(1)[0]
    expect(queued?.operation).toBe('create')
    expect(queued?.payload).not.toContain('_offline')
    expect((JSON.parse(queued?.payload ?? '{}') as { clock?: unknown }).clock).toEqual({
      'device-A': 3
    })
  })

  // A local edit is three transactions — row, clock, outbox — so a crash
  // between the last two leaves a clocked row with no queue row. The same shape
  // comes out of every increment*ClockOffline fallback. These types used to have
  // no startup sweep at all, so such an edit was lost for good (#2286).
  describe('record types swept by the dirty recovery registry', () => {
    type RowSync = {
      clock: Record<string, number> | null
      syncedAt: string | null
      modifiedAt: string
    }
    interface SweptTypeFixture {
      type: RecordSyncItemType
      init(): void
      reset(): void
      insert(id: string, sync: RowSync): void
      /** False where the table has no modification timestamp to compare. */
      tracksModification: boolean
      readClock(id: string): unknown
    }

    const deps = (): Parameters<typeof initFilterSyncService>[0] => ({
      queue,
      db,
      getDeviceId: () => 'device-A'
    })
    const ms = (iso: string | null): number | null => (iso === null ? null : Date.parse(iso))

    const FIXTURES: SweptTypeFixture[] = [
      {
        type: 'filter',
        init: () => initFilterSyncService(deps()),
        reset: resetFilterSyncService,
        insert: (id, { clock, syncedAt }) =>
          db.insert(savedFilters).values({ id, name: id, config: {}, clock, syncedAt }).run(),
        tracksModification: false,
        readClock: (id) =>
          db.select().from(savedFilters).where(eq(savedFilters.id, id)).get()?.clock
      },
      {
        type: 'bookmark',
        init: () => initBookmarkSyncService(deps()),
        reset: resetBookmarkSyncService,
        insert: (id, { clock, syncedAt }) =>
          db
            .insert(bookmarks)
            .values({ id, itemType: 'note', itemId: `${id}-target`, clock, syncedAt })
            .run(),
        tracksModification: false,
        readClock: (id) => db.select().from(bookmarks).where(eq(bookmarks.id, id)).get()?.clock
      },
      {
        type: 'template',
        init: () => initTemplateSyncService(deps()),
        reset: resetTemplateSyncService,
        insert: (id, sync) =>
          db
            .insert(templates)
            .values({ id, name: id, ...sync })
            .run(),
        tracksModification: true,
        readClock: (id) => db.select().from(templates).where(eq(templates.id, id)).get()?.clock
      },
      {
        type: 'home_page',
        init: () => initHomePageSyncService(deps()),
        reset: resetHomePageSyncService,
        insert: (id, { clock, syncedAt, modifiedAt }) =>
          db
            .insert(homePages)
            .values({ id, name: id, clock, syncedAt, updatedAt: modifiedAt })
            .run(),
        tracksModification: true,
        readClock: (id) => db.select().from(homePages).where(eq(homePages.id, id)).get()?.clock
      },
      {
        type: 'custom_icon',
        init: () => initCustomIconSyncService(deps()),
        reset: resetCustomIconSyncService,
        insert: (id, { clock, syncedAt, modifiedAt }) =>
          db
            .insert(customIcons)
            .values({ id, name: id, ext: 'png', data: 'x', clock, syncedAt, updatedAt: modifiedAt })
            .run(),
        tracksModification: true,
        readClock: (id) => db.select().from(customIcons).where(eq(customIcons.id, id)).get()?.clock
      },
      {
        type: 'reminder',
        init: () => initReminderSyncService(deps()),
        reset: resetReminderSyncService,
        insert: (id, sync) =>
          db
            .insert(reminders)
            .values({
              id,
              targetType: 'task',
              targetId: `${id}-target`,
              remindAt: '2026-02-01T00:00:00.000Z',
              ...sync
            })
            .run(),
        tracksModification: true,
        readClock: (id) => db.select().from(reminders).where(eq(reminders.id, id)).get()?.clock
      },
      {
        type: 'canvas_folder',
        init: () => initCanvasFolderSyncService(deps()),
        reset: resetCanvasFolderSyncService,
        // Epoch ms, not ISO: canvas_folders matches canvases.
        insert: (id, { clock, syncedAt, modifiedAt }) =>
          db
            .insert(canvasFolders)
            .values({
              id,
              vaultId: 'vault-1',
              path: id,
              createdAt: Date.parse('2026-01-01T00:00:00Z'),
              updatedAt: Date.parse(modifiedAt),
              clock,
              syncedAt: ms(syncedAt)
            })
            .run(),
        tracksModification: true,
        readClock: (id) =>
          db.select().from(canvasFolders).where(eq(canvasFolders.id, id)).get()?.clock
      },
      {
        type: 'task_activity',
        init: () => initTaskActivitySyncService(deps()),
        reset: resetTaskActivitySyncService,
        // Inside the retention window, or the row is pruned rather than pushed.
        insert: (id, { clock, syncedAt }) =>
          db
            .insert(taskActivity)
            .values({
              id,
              taskId: 'task-1',
              action: 'created',
              createdAt: new Date().toISOString(),
              clock,
              syncedAt
            })
            .run(),
        tracksModification: false,
        readClock: (id) =>
          db.select().from(taskActivity).where(eq(taskActivity.id, id)).get()?.clock
      }
    ]

    // The five arms that predate the registry keep their own tests above.
    const SWEPT_ABOVE: RecordSyncItemType[] = ['task', 'project', 'note', 'journal', 'inbox']

    it('covers every record sync item type with a sweep or a stated exemption (#2286)', () => {
      expect(Object.keys(DIRTY_RECOVERY).sort()).toEqual([...RECORD_SYNC_ITEM_TYPES].sort())
      for (const type of RECORD_SYNC_ITEM_TYPES) {
        const entry = DIRTY_RECOVERY[type]
        if (entry.kind === 'exempt') expect(entry.reason.trim(), type).not.toBe('')
      }

      const swept = RECORD_SYNC_ITEM_TYPES.filter((type) => DIRTY_RECOVERY[type].kind === 'sweep')
      const tested = [...SWEPT_ABOVE, ...FIXTURES.map((fixture) => fixture.type)]
      expect([...swept].sort()).toEqual(tested.sort())
    })

    describe.each(FIXTURES)('$type', (fixture) => {
      beforeEach(() => fixture.init())
      afterEach(() => fixture.reset())

      const pushed = (): { operation?: string; raw: string; clock: unknown } => {
        const queued = queue.peek(1)[0]
        const raw = queued?.payload ?? '{}'
        return {
          operation: queued?.operation,
          raw,
          clock: (JSON.parse(raw) as { clock?: unknown }).clock
        }
      }

      it.runIf(fixture.tracksModification)(
        're-pushes a row modified after its last sync at its stored clock (#2286)',
        () => {
          // #given — the clock advanced (here under `_offline`), the queue row
          // never landed
          fixture.insert('dirty', {
            clock: { 'device-A': 1, _offline: 1 },
            syncedAt: '2026-01-01T00:00:00.000Z',
            modifiedAt: '2026-01-02T00:00:00.000Z'
          })

          // #when
          recoverDirtyItems(db)

          // #then — one update, rebound but not bumped a second time
          expect(queue.getPendingCount()).toBe(1)
          const item = pushed()
          expect(item.operation).toBe('update')
          expect(item.raw).not.toContain('_offline')
          expect(item.clock).toEqual({ 'device-A': 2 })
          expect(fixture.readClock('dirty')).toEqual({ 'device-A': 2 })
        }
      )

      it('pushes a clocked never-synced row as a create with no _offline key on the wire (#2286)', () => {
        // #given — created while signed out: the offline fallback clocked it
        // under `_offline` and wrote no queue row
        fixture.insert('offline', {
          clock: { _offline: 2 },
          syncedAt: null,
          modifiedAt: '2026-01-02T00:00:00.000Z'
        })

        // #when
        recoverDirtyItems(db)

        // #then
        expect(queue.getPendingCount()).toBe(1)
        const item = pushed()
        expect(item.operation).toBe('create')
        expect(item.raw).not.toContain('_offline')
        expect(item.clock).toEqual({ 'device-A': 3 })
        expect(fixture.readClock('offline')).toEqual({ 'device-A': 3 })
      })

      it('leaves clean and clock-less rows alone', () => {
        fixture.insert('clean', {
          clock: { 'device-A': 1 },
          syncedAt: '2026-01-03T00:00:00.000Z',
          modifiedAt: '2026-01-02T00:00:00.000Z'
        })
        // seedUnclocked owns the first push of a row with no clock
        fixture.insert('unclocked', {
          clock: null,
          syncedAt: null,
          modifiedAt: '2026-01-02T00:00:00.000Z'
        })

        recoverDirtyItems(db)

        expect(queue.getPendingCount()).toBe(0)
      })
    })

    it('keeps sweeping the other types when one type throws', () => {
      // #given — a dirty note whose service throws, and a dirty task after it
      db.insert(noteMetadata)
        .values({
          id: 'note-throws',
          path: 'notes/note-throws.md',
          title: 'A note',
          createdAt: '2026-01-01T00:00:00Z',
          clock: { 'device-A': 1 },
          modifiedAt: '2026-01-02T00:00:00Z'
        } as never)
        .run()
      db.insert(tasks)
        .values({ id: 'task-after', projectId: 'proj-1', title: 'T', priority: 0, position: 0 })
        .run()
      const throwingNotes = {
        getLocal: (type: string) =>
          type === 'note'
            ? {
                enqueueRecoveredUpdate: () => {
                  throw new Error('payload builder failed')
                }
              }
            : undefined
      } as unknown as Parameters<typeof recoverDirtyItems>[1]

      // #when / #then — runtime start is not aborted, and tasks still recover
      expect(recoverDirtyItems(db, throwingNotes).tasks).toBe(1)
    })

    it('skips a soft-deleted canvas folder, whose delete has its own replay', () => {
      initCanvasFolderSyncService(deps())
      db.insert(canvasFolders)
        .values({
          id: 'folder-gone',
          vaultId: 'vault-1',
          path: 'Gone',
          createdAt: 1,
          updatedAt: 3,
          deletedAt: 3,
          clock: { 'device-A': 2 },
          syncedAt: 2
        })
        .run()

      recoverDirtyItems(db)

      expect(queue.getPendingCount()).toBe(0)
      resetCanvasFolderSyncService()
    })
  })
})
