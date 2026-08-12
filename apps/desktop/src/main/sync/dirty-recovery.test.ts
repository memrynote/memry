import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { eq } from 'drizzle-orm'
import { createTestDataDb, asClientDb, type TestDatabaseResult } from '@tests/utils/test-db'
import { tasks } from '@memry/db-schema/schema/tasks'
import { projects } from '@memry/db-schema/schema/projects'
import { noteMetadata } from '@memry/db-schema/data-schema'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { syncDevices } from '@memry/db-schema/schema/sync-devices'
import type { DataDb } from '../database/client'
import { incrementNoteClockOffline } from './offline-clock'
import { SyncQueueManager } from './queue'
import { initTaskSyncService, resetTaskSyncService } from './task-sync'
import { initProjectSyncService, resetProjectSyncService } from './project-sync'
import { initInboxSyncService, resetInboxSyncService } from './inbox-sync'
import { recoverDirtyItems } from './dirty-recovery'

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
    const clock = task.clock as Record<string, number>
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
    expect(task.fieldClocks ?? null).toBeNull()
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
    const clock = task.clock as Record<string, number>
    const fc = task.fieldClocks as Record<string, Record<string, number>>
    expect(clock._offline).toBeUndefined()
    expect(fc.statusId._offline).toBeUndefined()
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
})
