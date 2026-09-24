import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { eq } from 'drizzle-orm'
import { calendarBindings } from '@memry/db-schema/schema/calendar-bindings'
import { calendarEvents } from '@memry/db-schema/schema/calendar-events'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { tasks } from '@memry/db-schema/schema/tasks'
import { createTestDataDb, seedTestData, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb } from '../../database'
import { getSetting, setSetting } from '../../settings/settings-store'
import { setDefaultGoogleCalendar } from '../google/onboarding'
import { promoteExternalEvent } from '../promote-external-event'
import { PROVIDER_CAPABILITIES } from './capabilities'
import {
  getProvider,
  registerProvider,
  resetProviderRegistry,
  type ProviderDefinition,
  type ProviderWriter
} from './registry'
import { syncLocalSourceToProvider } from './write-dispatch'
import {
  DEFAULT_WRITE_TARGET_SETTINGS_KEY,
  findCalendarByRemoteId,
  readDefaultWriteTarget,
  resolveWriteRoute,
  writeDefaultWriteTarget
} from './write-routing'

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
const COLLECTION = 'https://dav.example.com/calendars/me/work/'
const FAKE = 'fake-writer'

function fakeProvider(id: string, writer: ProviderWriter): ProviderDefinition {
  const unused = (): never => {
    throw new Error('not used')
  }
  return {
    id,
    capabilities: { ...PROVIDER_CAPABILITIES.google, supportsPush: false, authFlow: 'basic' },
    connect: unused,
    disconnect: unused,
    refresh: unused,
    hasAnyLocalAuth: async () => true,
    hasAccountLocalAuth: async () => true,
    onSelectionChanged: () => {},
    retrySource: unused,
    writer
  }
}

describe('write routing: exactly one provider writes each item (#2372)', () => {
  let dbResult: TestDatabaseResult
  let db: DataDb
  let projectId: string
  let statusId: string
  const table = PROVIDER_CAPABILITIES as Record<string, (typeof PROVIDER_CAPABILITIES)[string]>
  const googleWriter = { syncLocalSource: vi.fn(async () => null) }
  const fakeWriter = { syncLocalSource: vi.fn(async () => null) }

  beforeEach(() => {
    dbResult = createTestDataDb()
    db = dbResult.db as unknown as DataDb
    const seeded = seedTestData(dbResult.db)
    projectId = seeded.projectId
    statusId = seeded.statusIds.todo
    googleWriter.syncLocalSource.mockClear()
    fakeWriter.syncLocalSource.mockClear()
    table[FAKE] = { ...PROVIDER_CAPABILITIES.google, supportsPush: false, authFlow: 'basic' }
    resetProviderRegistry()
    registerProvider(fakeProvider('google', googleWriter))
    registerProvider(fakeProvider(FAKE, fakeWriter))
    dbResult.db
      .insert(calendarSources)
      .values([
        {
          id: 'google-calendar:primary',
          provider: 'google',
          kind: 'calendar',
          accountId: 'me@example.com',
          remoteId: 'primary@example.com',
          title: 'Primary',
          isSelected: true,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        },
        {
          id: `${FAKE}-calendar:work`,
          provider: FAKE,
          kind: 'calendar',
          accountId: 'dav-account',
          remoteId: COLLECTION,
          title: 'Work',
          isSelected: true,
          syncStatus: 'ok',
          createdAt: NOW,
          modifiedAt: NOW
        }
      ])
      .run()
  })

  afterEach(() => {
    delete table[FAKE]
    resetProviderRegistry()
    dbResult.close()
  })

  function insertTask(id: string): void {
    dbResult.db
      .insert(tasks)
      .values({
        id,
        projectId,
        statusId,
        title: 'Renew passport',
        position: 1,
        dueDate: '2026-09-30',
        clock: { 'device-a': 1 },
        fieldClocks: {},
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function insertEvent(id: string, targetCalendarId: string | null): void {
    dbResult.db
      .insert(calendarEvents)
      .values({
        id,
        title: 'Dentist',
        startAt: '2026-09-30T09:00:00.000Z',
        endAt: '2026-09-30T10:00:00.000Z',
        timezone: 'UTC',
        isAllDay: false,
        targetCalendarId,
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  function bind(sourceType: 'task' | 'event', sourceId: string, provider: string): void {
    dbResult.db
      .insert(calendarBindings)
      .values({
        id: `calendar_binding:${provider}:${sourceType}:${sourceId}`,
        sourceType,
        sourceId,
        provider,
        remoteCalendarId: provider === 'google' ? 'primary@example.com' : COLLECTION,
        remoteEventId: `${sourceId}-remote`,
        ownershipMode: 'memry_managed',
        writebackMode: 'broad',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
  }

  it('a task bound to another provider is never pushed to Google, even with a Google default', async () => {
    setSetting(
      db,
      'calendar.google',
      JSON.stringify({ defaultTargetCalendarId: 'primary@example.com', pushEventsToGoogle: true })
    )
    insertTask('routed-task-1')
    bind('task', 'routed-task-1', FAKE)

    await syncLocalSourceToProvider(db, { sourceType: 'task', sourceId: 'routed-task-1' })

    expect(googleWriter.syncLocalSource).not.toHaveBeenCalled()
    expect(fakeWriter.syncLocalSource).toHaveBeenCalledWith(
      db,
      { sourceType: 'task', sourceId: 'routed-task-1' },
      expect.objectContaining({ provider: FAKE, reason: 'binding' })
    )
  })

  it('an event whose target_calendar_id is the other provider’s collection routes to that provider', async () => {
    insertEvent('event-1', COLLECTION)

    await syncLocalSourceToProvider(db, { sourceType: 'event', sourceId: 'event-1' })

    expect(fakeWriter.syncLocalSource).toHaveBeenCalledWith(
      db,
      { sourceType: 'event', sourceId: 'event-1' },
      expect.objectContaining({ provider: FAKE, remoteCalendarId: COLLECTION })
    )
    expect(googleWriter.syncLocalSource).not.toHaveBeenCalled()
  })

  it('an install with only calendar.google settings routes exactly as today', () => {
    setSetting(
      db,
      'calendar.google',
      JSON.stringify({ defaultTargetCalendarId: 'tasks@group.calendar.google.com' })
    )
    insertTask('routed-task-2')
    insertEvent('event-unknown-target', 'work@group.calendar.google.com')
    insertEvent('event-no-target', null)

    expect(readDefaultWriteTarget(db)).toEqual({
      provider: 'google',
      remoteCalendarId: 'tasks@group.calendar.google.com'
    })
    expect(resolveWriteRoute(db, { sourceType: 'task', sourceId: 'routed-task-2' })).toMatchObject({
      provider: 'google',
      remoteCalendarId: 'tasks@group.calendar.google.com'
    })
    // A target no source knows is a Google id, as older builds always sent it.
    expect(
      resolveWriteRoute(db, { sourceType: 'event', sourceId: 'event-unknown-target' })
    ).toMatchObject({ provider: 'google', remoteCalendarId: 'work@group.calendar.google.com' })
    expect(getSetting(db, DEFAULT_WRITE_TARGET_SETTINGS_KEY)).toBeNull()
  })

  it('with no default anywhere, Google keeps its managed-calendar fallback', () => {
    insertTask('routed-task-3')
    expect(resolveWriteRoute(db, { sourceType: 'task', sourceId: 'routed-task-3' })).toEqual({
      provider: 'google',
      remoteCalendarId: null,
      binding: null,
      reason: 'legacy_google'
    })
  })

  it('the cross-provider default sends tasks, reminders and snoozes to exactly one provider', async () => {
    setSetting(
      db,
      'calendar.google',
      JSON.stringify({ defaultTargetCalendarId: 'primary@example.com', pushEventsToGoogle: true })
    )
    writeDefaultWriteTarget(db, { provider: FAKE, remoteCalendarId: COLLECTION })
    insertTask('routed-task-4')

    await syncLocalSourceToProvider(db, { sourceType: 'task', sourceId: 'routed-task-4' })

    expect(fakeWriter.syncLocalSource).toHaveBeenCalledTimes(1)
    expect(googleWriter.syncLocalSource).not.toHaveBeenCalled()
  })

  it('choosing a Google default later moves the cross-provider default back to Google', () => {
    writeDefaultWriteTarget(db, { provider: FAKE, remoteCalendarId: COLLECTION })
    setDefaultGoogleCalendar(db, {
      calendarId: 'primary@example.com',
      markOnboardingComplete: true
    })
    expect(readDefaultWriteTarget(db)).toEqual({
      provider: 'google',
      remoteCalendarId: 'primary@example.com'
    })
  })

  it('an existing binding wins over a retargeted event', () => {
    insertEvent('event-2', COLLECTION)
    bind('event', 'event-2', 'google')
    expect(resolveWriteRoute(db, { sourceType: 'event', sourceId: 'event-2' })).toMatchObject({
      provider: 'google',
      reason: 'binding'
    })
  })

  it('a read-only provider never reaches a writer, even when a definition carries one', async () => {
    const readOnlyWriter = { syncLocalSource: vi.fn(async () => null) }
    registerProvider({
      ...fakeProvider('ics', readOnlyWriter),
      capabilities: PROVIDER_CAPABILITIES.ics
    })
    insertTask('routed-task-5')
    bind('task', 'routed-task-5', 'ics')

    await syncLocalSourceToProvider(db, { sourceType: 'task', sourceId: 'routed-task-5' })

    expect(readOnlyWriter.syncLocalSource).not.toHaveBeenCalled()
    expect(googleWriter.syncLocalSource).not.toHaveBeenCalled()
    expect(getProvider('ics')).not.toBeNull()
  })

  it('on a collision Google wins, so existing installs behave the same', () => {
    dbResult.db
      .insert(calendarSources)
      .values({
        id: `${FAKE}-calendar:collide`,
        provider: FAKE,
        kind: 'calendar',
        remoteId: 'primary@example.com',
        title: 'Collision',
        syncStatus: 'ok',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()
    expect(findCalendarByRemoteId(db, 'primary@example.com')?.provider).toBe('google')
  })

  it('promotion binds the copy to the source’s own provider', () => {
    dbResult.db
      .insert(calendarExternalEvents)
      .values({
        id: 'external-1',
        sourceId: `${FAKE}-calendar:work`,
        remoteEventId: `${COLLECTION}abc.ics`,
        remoteEtag: '"e1"',
        title: 'Standup',
        startAt: '2026-09-30T09:00:00.000Z',
        isAllDay: false,
        status: 'confirmed',
        createdAt: NOW,
        modifiedAt: NOW
      })
      .run()

    const { eventId } = promoteExternalEvent(db, { externalEventId: 'external-1' })

    const binding = dbResult.db
      .select()
      .from(calendarBindings)
      .where(eq(calendarBindings.sourceId, eventId!))
      .get()
    expect(binding).toMatchObject({
      provider: FAKE,
      remoteCalendarId: COLLECTION,
      remoteEventId: `${COLLECTION}abc.ics`
    })
    expect(resolveWriteRoute(db, { sourceType: 'event', sourceId: eventId! }).provider).toBe(FAKE)
  })
})
