import { describe, it, expect, beforeEach, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { createTestDataDb, type TestDataDb } from '../../../test/helpers/test-data-db'

vi.mock('../../lib/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  })
}))

import { calendarBindingHandler } from './calendar-binding-handler'
import { calendarSourceHandler } from './calendar-source-handler'

/**
 * Gap coverage for `calendar-source-binding-handlers.test.ts`, which already
 * exercises every branch of both handlers (insert defaults, stale skip,
 * concurrent conflict, all three delete outcomes, fetchLocal, buildPushPayload,
 * seedUnclocked) but always sends a *complete* remote payload — so the
 * `data.<field> ?? existing.<field>` merge contract that protects local values
 * against a payload written by an older app version is never asserted. It also
 * never asserts `ctx.emit` for the binding handler, nor on either delete path.
 */

let db: TestDataDb
const emit = vi.fn()
const ctx = () => ({ db, emit })

beforeEach(() => {
  db = createTestDataDb()
  emit.mockClear()
})

describe('calendarSourceHandler — partial payload merge', () => {
  it('keeps every local field the remote payload omits', () => {
    calendarSourceHandler.applyUpsert(
      ctx(),
      'source-1',
      {
        provider: 'google',
        kind: 'calendar',
        accountId: 'account-1',
        remoteId: 'remote-1',
        title: 'Work',
        timezone: 'Europe/Istanbul',
        color: '#ff0000',
        isPrimary: true,
        isSelected: true,
        isMemryManaged: true,
        syncCursor: 'cursor-1',
        syncStatus: 'ok',
        lastSyncedAt: '2026-05-01T00:00:00.000Z',
        metadata: { pageToken: 'next' }
      },
      { 'device-a': 1 }
    )

    // Older peer: dominating clock, but only the fields that version knows about.
    expect(
      calendarSourceHandler.applyUpsert(
        ctx(),
        'source-1',
        { title: 'Work renamed' },
        {
          'device-a': 2
        }
      )
    ).toBe('applied')

    expect(
      db.select().from(calendarSources).where(eq(calendarSources.id, 'source-1')).get()
    ).toMatchObject({
      title: 'Work renamed',
      accountId: 'account-1',
      remoteId: 'remote-1',
      timezone: 'Europe/Istanbul',
      color: '#ff0000',
      isPrimary: true,
      isSelected: true,
      isMemryManaged: true,
      syncCursor: 'cursor-1',
      syncStatus: 'ok',
      lastSyncedAt: '2026-05-01T00:00:00.000Z',
      metadata: { pageToken: 'next' }
    })
  })

  it('emits calendar:changed when a delete is applied', () => {
    calendarSourceHandler.applyUpsert(ctx(), 'source-1', { title: 'Work' }, { 'device-a': 1 })
    emit.mockClear()

    expect(calendarSourceHandler.applyDelete(ctx(), 'source-1', { 'device-a': 2 })).toBe('applied')
    expect(emit).toHaveBeenCalledWith('calendar:changed', {
      entityType: 'calendar_source',
      id: 'source-1'
    })
  })

  it('emits nothing when a delete is skipped', () => {
    calendarSourceHandler.applyUpsert(ctx(), 'source-1', { title: 'Work' }, { 'device-a': 5 })
    emit.mockClear()

    expect(calendarSourceHandler.applyDelete(ctx(), 'source-1', { 'device-a': 2 })).toBe('skipped')
    expect(emit).not.toHaveBeenCalled()
  })
})

describe('calendarBindingHandler — partial payload merge and events', () => {
  it('keeps every local field the remote payload omits', () => {
    calendarBindingHandler.applyUpsert(
      ctx(),
      'binding-1',
      {
        sourceType: 'task',
        sourceId: 'task-1',
        provider: 'google',
        remoteCalendarId: 'calendar-1',
        remoteEventId: 'event-1',
        ownershipMode: 'provider_managed',
        writebackMode: 'schedule_only',
        remoteVersion: 'etag-1',
        lastLocalSnapshot: { title: 'Task' }
      },
      { 'device-a': 1 }
    )

    expect(
      calendarBindingHandler.applyUpsert(
        ctx(),
        'binding-1',
        { remoteVersion: 'etag-2' },
        {
          'device-a': 2
        }
      )
    ).toBe('applied')

    expect(
      db.select().from(calendarBindings).where(eq(calendarBindings.id, 'binding-1')).get()
    ).toMatchObject({
      sourceType: 'task',
      sourceId: 'task-1',
      remoteCalendarId: 'calendar-1',
      remoteEventId: 'event-1',
      ownershipMode: 'provider_managed',
      writebackMode: 'schedule_only',
      remoteVersion: 'etag-2',
      lastLocalSnapshot: { title: 'Task' }
    })
  })

  it('emits calendar:changed on insert, on update, and on an applied delete', () => {
    calendarBindingHandler.applyUpsert(ctx(), 'binding-1', {}, { 'device-a': 1 })
    expect(emit).toHaveBeenCalledWith('calendar:changed', {
      entityType: 'calendar_binding',
      id: 'binding-1'
    })

    emit.mockClear()
    calendarBindingHandler.applyUpsert(
      ctx(),
      'binding-1',
      { remoteVersion: 'etag-1' },
      { 'device-a': 2 }
    )
    expect(emit).toHaveBeenCalledWith('calendar:changed', {
      entityType: 'calendar_binding',
      id: 'binding-1'
    })

    emit.mockClear()
    expect(calendarBindingHandler.applyDelete(ctx(), 'binding-1', { 'device-a': 3 })).toBe(
      'applied'
    )
    expect(emit).toHaveBeenCalledWith('calendar:changed', {
      entityType: 'calendar_binding',
      id: 'binding-1'
    })
  })

  it('emits nothing when a delete is skipped', () => {
    calendarBindingHandler.applyUpsert(ctx(), 'binding-1', {}, { 'device-a': 5 })
    emit.mockClear()

    expect(calendarBindingHandler.applyDelete(ctx(), 'binding-1', { 'device-b': 1 })).toBe(
      'skipped'
    )
    expect(emit).not.toHaveBeenCalled()
  })
})
