import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { TaskActivityActors } from '@memry/db-schema/schema/task-activity'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../../database'
import { getCalendarSourceById } from '../repositories/calendar-sources-repository'
import { promoteExternalEvent } from '../promote-external-event'
import { PROVIDER_CAPABILITIES } from '../provider/capabilities'
import { ProviderGoneError, ProviderRateLimitError } from '../provider/errors'
import {
  registerProvider,
  resetProviderRegistry,
  type ProviderDefinition
} from '../provider/registry'
import { syncLocalSourceToProvider } from '../provider/write-dispatch'
import type { RemoteCalendarEvent } from '../types'
import { pullWithCursorReset } from './cursor-reset'
import { createPollRunner } from './poll-runner'
import {
  ProviderReadOnlyError,
  applyProviderDelete,
  applyProviderWriteback,
  deleteSourceFromProvider,
  pushSourceToProvider,
  runExclusive,
  type ProviderWriteAdapter
} from './write-engine'

vi.mock('../change-events', () => ({
  emitCalendarChanged: vi.fn(),
  emitCalendarProjectionChanged: vi.fn()
}))
vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

const NOW = '2026-09-24T08:00:00.000Z'
const WRITER = 'fake-writer'
const READER = 'fake-reader'

function remote(calendarId: string, id: string): RemoteCalendarEvent {
  return {
    id,
    calendarId,
    title: 'Remote title',
    description: null,
    location: null,
    startAt: '2026-09-30T09:00:00.000Z',
    endAt: '2026-09-30T10:00:00.000Z',
    isAllDay: false,
    timezone: 'UTC',
    status: 'confirmed',
    etag: '"r1"',
    updatedAt: NOW,
    attendees: null,
    reminders: null,
    visibility: null,
    colorId: null,
    conferenceData: null,
    recurringEventId: null,
    originalStartTime: null,
    raw: {}
  }
}

function fakeAdapter(): ProviderWriteAdapter & {
  upsertEvent: ReturnType<typeof vi.fn>
  deleteEvent: ReturnType<typeof vi.fn>
  getEvent: ReturnType<typeof vi.fn>
} {
  return {
    upsertEvent: vi.fn(async ({ calendarId, eventId }) =>
      remote(calendarId, eventId ?? 'new-remote')
    ),
    getEvent: vi.fn(async ({ calendarId, eventId }) => remote(calendarId, eventId)),
    deleteEvent: vi.fn(async () => {})
  }
}

describe('generalized write engine (#1393)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  const table = PROVIDER_CAPABILITIES as Record<string, (typeof PROVIDER_CAPABILITIES)[string]>

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    table[WRITER] = { ...PROVIDER_CAPABILITIES.google, supportsPush: false, authFlow: 'basic' }
    table[READER] = { ...PROVIDER_CAPABILITIES.ics }
    dbResult.db
      .insert(calendarEvents)
      .values({
        id: 'event-1',
        title: 'Planning',
        startAt: '2026-09-30T09:00:00.000Z',
        endAt: '2026-09-30T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  })

  afterEach(() => {
    delete table[WRITER]
    delete table[READER]
    resetProviderRegistry()
    dbResult.close()
  })

  function bindings() {
    return dbResult.db.select().from(calendarBindings).all()
  }

  it('pushes through any writable provider and records its binding', async () => {
    const adapter = fakeAdapter()
    const binding = await pushSourceToProvider(
      db,
      WRITER,
      { sourceType: 'event', sourceId: 'event-1' },
      { adapter, calendarId: 'collection-1' }
    )
    expect(binding).toMatchObject({
      id: `calendar_binding:${WRITER}:event:event-1`,
      provider: WRITER,
      remoteCalendarId: 'collection-1',
      remoteEventId: 'new-remote',
      remoteVersion: '"r1"'
    })
    expect(adapter.upsertEvent).toHaveBeenCalledWith(
      expect.objectContaining({ calendarId: 'collection-1', eventId: null, ifMatch: null })
    )
  })

  describe('a supportsWrite: false provider never reaches a binding or a push call', () => {
    it('on the push, delete and write-back paths', async () => {
      const adapter = fakeAdapter()
      const target = { sourceType: 'event' as const, sourceId: 'event-1' }
      await expect(
        pushSourceToProvider(db, READER, target, { adapter, calendarId: 'c' })
      ).rejects.toBeInstanceOf(ProviderReadOnlyError)
      await expect(
        deleteSourceFromProvider(db, READER, target, { adapter })
      ).rejects.toBeInstanceOf(ProviderReadOnlyError)
      await expect(
        applyProviderWriteback(
          db,
          READER,
          { ...target, writebackMode: 'broad' },
          remote('c', 'r'),
          { actor: TaskActivityActors.SYNC }
        )
      ).rejects.toBeInstanceOf(ProviderReadOnlyError)
      await expect(
        applyProviderDelete(
          db,
          READER,
          { ...target, writebackMode: 'broad' },
          {
            actor: TaskActivityActors.SYNC
          }
        )
      ).rejects.toBeInstanceOf(ProviderReadOnlyError)

      expect(adapter.upsertEvent).not.toHaveBeenCalled()
      expect(adapter.deleteEvent).not.toHaveBeenCalled()
      expect(bindings()).toEqual([])
      expect(
        dbResult.db.select().from(calendarEvents).where(eq(calendarEvents.id, 'event-1')).get()
          ?.title
      ).toBe('Planning')
    })

    it('on the routed local-change path, even with a writer registered for it', async () => {
      const writer = { syncLocalSource: vi.fn(async () => null) }
      const unused = (): never => {
        throw new Error('unused')
      }
      const definition: ProviderDefinition = {
        id: READER,
        capabilities: table[READER],
        connect: unused,
        disconnect: unused,
        refresh: unused,
        hasAnyLocalAuth: async () => true,
        hasAccountLocalAuth: async () => true,
        onSelectionChanged: () => {},
        retrySource: unused,
        writer
      }
      registerProvider(definition)
      dbResult.db
        .insert(calendarSources)
        .values({
          id: 'reader-cal',
          provider: READER,
          kind: 'calendar',
          remoteId: 'reader-remote',
          title: 'Feed',
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      dbResult.db
        .update(calendarEvents)
        .set({ targetCalendarId: 'reader-remote' })
        .where(eq(calendarEvents.id, 'event-1'))
        .run()

      await syncLocalSourceToProvider(db, { sourceType: 'event', sourceId: 'event-1' })

      expect(writer.syncLocalSource).not.toHaveBeenCalled()
      expect(bindings()).toEqual([])
    })

    it('on the promotion path', () => {
      dbResult.db
        .insert(calendarSources)
        .values({
          id: 'reader-cal',
          provider: READER,
          kind: 'calendar',
          remoteId: 'reader-remote',
          title: 'Feed',
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      dbResult.db
        .insert(calendarExternalEvents)
        .values({
          id: 'mirror-1',
          sourceId: 'reader-cal',
          remoteEventId: 'remote-1',
          title: 'Feed event',
          startAt: NOW,
          isAllDay: false,
          status: 'confirmed',
          createdAt: NOW,
          modifiedAt: NOW
        })
        .run()
      expect(() => promoteExternalEvent(db, { externalEventId: 'mirror-1' })).toThrow()
      expect(bindings()).toEqual([])
    })
  })

  it('two providers sync concurrently and neither blocks the other', async () => {
    let releaseSlow: () => void = () => {}
    const slow = runExclusive(
      `${WRITER}:account-a`,
      () =>
        new Promise<string>((resolve) => {
          releaseSlow = () => resolve('slow done')
        })
    )

    // Another provider (and another account) runs straight through.
    await expect(runExclusive(`google:account-b`, async () => 'fast done')).resolves.toBe(
      'fast done'
    )
    // The same provider and account is skipped while its pass is running.
    await expect(
      runExclusive(`${WRITER}:account-a`, async () => 'duplicate')
    ).resolves.toBeUndefined()

    releaseSlow()
    await expect(slow).resolves.toBe('slow done')
    await expect(runExclusive(`${WRITER}:account-a`, async () => 'next pass')).resolves.toBe(
      'next pass'
    )
  })

  it('ProviderGoneError resets the cursor and triggers a full resync', async () => {
    dbResult.db
      .insert(calendarSources)
      .values({
        id: 'writer-cal',
        provider: WRITER,
        kind: 'calendar',
        remoteId: 'collection-1',
        title: 'Work',
        syncCursor: 'stale-cursor',
        syncStatus: 'ok',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
    const seen: Array<string | null> = []
    const pull = vi.fn(async (source: { syncCursor: string | null }) => {
      seen.push(source.syncCursor)
      if (source.syncCursor) throw new ProviderGoneError(WRITER)
      return 'full'
    })

    const result = await pullWithCursorReset(
      db,
      WRITER,
      getCalendarSourceById(db, 'writer-cal')!,
      pull
    )

    expect(result).toBe('full')
    expect(seen).toEqual(['stale-cursor', null])
    expect(getCalendarSourceById(db, 'writer-cal')).toMatchObject({
      syncCursor: null,
      syncStatus: 'pending'
    })
  })
})

describe('poll runner (#1393)', () => {
  function fakeTimers() {
    const pending: Array<{ at: number; callback: () => void; handle: number }> = []
    let now = 0
    let next = 1
    return {
      timers: {
        setTimeout: (callback: () => void, ms: number) => {
          const handle = next++
          pending.push({ at: now + ms, callback, handle })
          return handle as unknown as ReturnType<typeof setTimeout>
        },
        clearTimeout: (handle: ReturnType<typeof setTimeout>) => {
          const index = pending.findIndex((entry) => entry.handle === (handle as unknown as number))
          if (index >= 0) pending.splice(index, 1)
        }
      },
      nextDelay: () => (pending.length ? pending[0].at - now : null),
      async fire() {
        const entry = pending.shift()
        if (!entry) return
        now = entry.at
        entry.callback()
        await new Promise((resolve) => setTimeout(resolve, 0))
      }
    }
  }

  it('waits retryAfterMs after a ProviderRateLimitError, then returns to its interval', async () => {
    const clock = fakeTimers()
    const run = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new ProviderRateLimitError(WRITER, 45 * 60 * 1000))
      .mockResolvedValue(undefined)
    const runner = createPollRunner({
      name: 'test',
      intervalMs: 15 * 60 * 1000,
      run,
      timers: clock.timers
    })

    runner.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(run).toHaveBeenCalledTimes(1)
    expect(clock.nextDelay()).toBe(45 * 60 * 1000)

    await clock.fire()
    expect(run).toHaveBeenCalledTimes(2)
    expect(clock.nextDelay()).toBe(15 * 60 * 1000)
    runner.stop()
    expect(clock.nextDelay()).toBeNull()
  })

  it('honours a retryAfterMs a pass reports without throwing', async () => {
    const clock = fakeTimers()
    const runner = createPollRunner({
      name: 'test',
      intervalMs: 1000,
      run: async () => ({ retryAfterMs: 5000 }),
      timers: clock.timers
    })
    runner.start()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(clock.nextDelay()).toBe(5000)
    runner.stop()
  })
})
