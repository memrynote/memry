import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { inboxItems } from '@memry/db-schema/schema/inbox'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { inboxHandler } from './inbox-handler'
import { SyncQueueManager } from '@memry/sync-client/queue'

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })
const rowOf = (id: string) => db.select().from(inboxItems).where(eq(inboxItems.id, id)).get()

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('inboxHandler', () => {
  it('inserts a remote item that does not exist locally and emits inbox:captured', () => {
    const result = inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      {
        title: 'Read later',
        type: 'link',
        content: 'excerpt',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        captureSource: 'clipper'
      },
      { deviceA: 1 }
    )

    expect(result).toBe('applied')
    const row = rowOf('inbox-1')
    expect(row).toMatchObject({
      id: 'inbox-1',
      title: 'Read later',
      type: 'link',
      content: 'excerpt',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Example',
      captureSource: 'clipper',
      clock: { deviceA: 1 }
    })
    expect(row?.syncedAt).toBeTruthy()
    expect(emit).toHaveBeenCalledWith('inbox:captured', { id: 'inbox-1' })
  })

  it('falls back to the Untitled/note defaults when the payload omits title and type', () => {
    expect(inboxHandler.applyUpsert(ctx(), 'inbox-1', {}, { deviceA: 1 })).toBe('applied')

    expect(rowOf('inbox-1')).toMatchObject({ title: 'Untitled', type: 'note' })
  })

  it('skips a stale remote update, leaves the local row untouched, and emits nothing', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local', type: 'note' }, { deviceA: 5 })
    emit.mockClear()
    const before = rowOf('inbox-1')

    const result = inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      { title: 'Stale remote', type: 'link' },
      { deviceA: 2 }
    )

    expect(result).toBe('skipped')
    expect(rowOf('inbox-1')).toEqual(before)
    expect(emit).not.toHaveBeenCalled()
  })

  it('reports a conflict on concurrent clocks, keeps the remote value, and merges the clock', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 3 })
    emit.mockClear()

    const result = inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Remote' }, { deviceB: 4 })

    expect(result).toBe('conflict')
    expect(rowOf('inbox-1')).toMatchObject({
      title: 'Remote',
      clock: { deviceA: 3, deviceB: 4 }
    })
    expect(emit).toHaveBeenCalledWith('inbox:updated', { id: 'inbox-1' })
  })

  it('applies and emits inbox:updated when the remote clock cleanly dominates', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 3 })
    emit.mockClear()

    const result = inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      { title: 'Newer', content: 'body' },
      { deviceA: 7 }
    )

    expect(result).toBe('applied')
    expect(rowOf('inbox-1')).toMatchObject({
      title: 'Newer',
      content: 'body',
      clock: { deviceA: 7 }
    })
    expect(emit).toHaveBeenCalledWith('inbox:updated', { id: 'inbox-1' })
  })

  it('falls back to the payload clock when the transport clock is empty', () => {
    expect(
      inboxHandler.applyUpsert(
        ctx(),
        'inbox-1',
        { title: 'From payload', clock: { deviceA: 2 } },
        {}
      )
    ).toBe('applied')

    expect(rowOf('inbox-1')).toMatchObject({ clock: { deviceA: 2 } })
  })

  it('keeps title, type and captureSource when the remote payload omits them', () => {
    inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      { title: 'Kept', type: 'link', captureSource: 'clipper' },
      { deviceA: 1 }
    )

    expect(inboxHandler.applyUpsert(ctx(), 'inbox-1', {}, { deviceA: 2 })).toBe('applied')

    expect(rowOf('inbox-1')).toMatchObject({
      title: 'Kept',
      type: 'link',
      captureSource: 'clipper'
    })
  })

  it('carries filed, snoozed and archived state onto a first-time insert', () => {
    // buildPushPayload ships the whole row, so an item archived on the origin
    // device must not land un-archived on a device seeing it for the first time.
    inboxHandler.applyUpsert(
      ctx(),
      'inbox-new',
      {
        title: 'Filed and archived',
        filedAt: '2026-08-01T00:00:00.000Z',
        filedTo: 'project-1',
        filedAction: 'move',
        snoozedUntil: '2026-09-01T00:00:00.000Z',
        snoozeReason: 'later',
        archivedAt: '2026-08-02T00:00:00.000Z'
      },
      { deviceA: 1 }
    )

    expect(rowOf('inbox-new')).toMatchObject({
      filedAt: '2026-08-01T00:00:00.000Z',
      filedTo: 'project-1',
      filedAction: 'move',
      snoozedUntil: '2026-09-01T00:00:00.000Z',
      snoozeReason: 'later',
      archivedAt: '2026-08-02T00:00:00.000Z'
    })
  })

  // The two halves of the nullable-field contract. They pull in opposite
  // directions, so both must be asserted: a blanket `?? null` fails the first,
  // a blanket `?? existing` fails the second.
  it('keeps local values for nullable keys the payload omits', () => {
    inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      {
        title: 'Kept',
        content: 'excerpt',
        sourceUrl: 'https://example.com',
        sourceTitle: 'Example',
        snoozedUntil: '2026-09-01T00:00:00.000Z',
        archivedAt: '2026-08-01T00:00:00.000Z',
        filedTo: 'project-1'
      },
      { deviceA: 1 }
    )

    // An app version predating those columns omits the keys entirely. It must
    // not be read as an instruction to clear them.
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Kept' }, { deviceA: 2 })

    expect(rowOf('inbox-1')).toMatchObject({
      content: 'excerpt',
      sourceUrl: 'https://example.com',
      sourceTitle: 'Example',
      snoozedUntil: '2026-09-01T00:00:00.000Z',
      archivedAt: '2026-08-01T00:00:00.000Z',
      filedTo: 'project-1'
    })
  })

  it('applies an explicit null as a remote clear', () => {
    inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      {
        title: 'Kept',
        content: 'excerpt',
        snoozedUntil: '2026-09-01T00:00:00.000Z',
        snoozeReason: 'later',
        archivedAt: '2026-08-01T00:00:00.000Z',
        filedAt: '2026-08-01T00:00:00.000Z',
        filedTo: 'project-1',
        filedAction: 'move'
      },
      { deviceA: 1 }
    )

    // What unsnoozeItem / unarchive / unfile push from the other device
    // (inbox/snooze.ts, inbox/crud.ts). buildPushPayload JSON.stringify's the
    // whole row, so a cleared column arrives as a present key holding null.
    inboxHandler.applyUpsert(
      ctx(),
      'inbox-1',
      {
        title: 'Kept',
        content: null,
        snoozedUntil: null,
        snoozeReason: null,
        archivedAt: null,
        filedAt: null,
        filedTo: null,
        filedAction: null
      },
      { deviceA: 2 }
    )

    expect(rowOf('inbox-1')).toMatchObject({
      content: null,
      snoozedUntil: null,
      snoozeReason: null,
      archivedAt: null,
      filedAt: null,
      filedTo: null,
      filedAction: null
    })
  })

  it('deletes the row and emits inbox:archived when the remote delete clock dominates', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 1 })
    emit.mockClear()

    const result = inboxHandler.applyDelete(ctx(), 'inbox-1', { deviceA: 2 })

    expect(result).toBe('applied')
    expect(rowOf('inbox-1')).toBeUndefined()
    expect(emit).toHaveBeenCalledWith('inbox:archived', { id: 'inbox-1' })
  })

  it('skips a delete for an unknown item and emits nothing', () => {
    expect(inboxHandler.applyDelete(ctx(), 'missing', { deviceA: 1 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })

  it('skips a delete when the local clock is newer or concurrent', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 5 })
    emit.mockClear()

    expect(inboxHandler.applyDelete(ctx(), 'inbox-1', { deviceA: 2 })).toBe('skipped')
    expect(inboxHandler.applyDelete(ctx(), 'inbox-1', { deviceB: 1 })).toBe('skipped')
    expect(rowOf('inbox-1')).toBeDefined()
    expect(emit).not.toHaveBeenCalled()
  })

  it('fetches the local row and reports undefined for an unknown id', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 1 })

    expect(inboxHandler.fetchLocal(db, 'inbox-1')).toMatchObject({ title: 'Local' })
    expect(inboxHandler.fetchLocal(db, 'missing')).toBeUndefined()
  })

  it('builds a push payload but never pushes local-only items', () => {
    inboxHandler.applyUpsert(ctx(), 'inbox-1', { title: 'Local' }, { deviceA: 1 })

    expect(
      JSON.parse(inboxHandler.buildPushPayload(db, 'inbox-1', 'deviceA', 'update')!)
    ).toMatchObject({ id: 'inbox-1', title: 'Local', clock: { deviceA: 1 } })
    expect(inboxHandler.buildPushPayload(db, 'missing', 'deviceA', 'update')).toBeNull()

    db.update(inboxItems).set({ localOnly: true }).where(eq(inboxItems.id, 'inbox-1')).run()
    expect(inboxHandler.buildPushPayload(db, 'inbox-1', 'deviceA', 'update')).toBeNull()
  })

  it('stamps syncedAt on markPushSynced', () => {
    db.insert(inboxItems).values({ id: 'inbox-1', title: 'Local', type: 'note' }).run()
    expect(rowOf('inbox-1')?.syncedAt).toBeNull()

    inboxHandler.markPushSynced(db, 'inbox-1')

    expect(rowOf('inbox-1')?.syncedAt).toBeTruthy()
  })

  it('seeds unclocked items into the queue and leaves local-only items alone', () => {
    db.insert(inboxItems)
      .values([
        { id: 'inbox-unclocked', title: 'Unclocked', type: 'note' },
        { id: 'inbox-local', title: 'Local only', type: 'note', localOnly: true }
      ])
      .run()

    const queue = new SyncQueueManager(db)
    expect(inboxHandler.seedUnclocked(db, 'deviceA', queue)).toBe(1)

    expect(rowOf('inbox-unclocked')).toMatchObject({ clock: { deviceA: 1 } })
    expect(rowOf('inbox-local')?.clock).toBeNull()

    const [queued] = queue.dequeue(5)
    expect(queued).toMatchObject({
      type: 'inbox',
      itemId: 'inbox-unclocked',
      operation: 'create'
    })
    expect(JSON.parse(queued.payload)).toMatchObject({
      id: 'inbox-unclocked',
      clock: { deviceA: 1 }
    })
  })
})
