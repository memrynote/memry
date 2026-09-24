import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DEVICE_LOCAL_CALENDAR_PROVIDERS,
  GOOGLE_CALENDAR_PROVIDER,
  ICS_CALENDAR_PROVIDER
} from '@memry/contracts/calendar-api'
import { calendarSources } from '@memry/db-schema/schema/calendar-sources'
import { calendarExternalEvents } from '@memry/db-schema/schema/calendar-external-events'
import { createTestDataDb, createTestIndexDb, type TestDatabaseResult } from '@tests/utils/test-db'
import type { DataDb, IndexDb } from '../../database'
import { getCalendarRangeProjection } from '../projection'
import { ExternalEventReadOnlyError, promoteExternalEvent } from '../promote-external-event'
import {
  PROVIDER_CAPABILITIES,
  UNKNOWN_PROVIDER_CAPABILITIES,
  isKnownProvider,
  isProviderAvailableOn,
  providerCapabilities,
  sourceCapabilities
} from './capabilities'

vi.mock('../change-events', () => ({
  emitCalendarProjectionChanged: vi.fn(),
  emitCalendarChanged: vi.fn()
}))

vi.mock('../../sync/local-mutations', () => ({
  enqueueLocalSyncCreate: vi.fn(),
  enqueueLocalSyncUpdate: vi.fn(),
  enqueueLocalSyncDelete: vi.fn()
}))

vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))

const NOW = '2026-09-24T08:00:00.000Z'

function seedExternal(db: TestDatabaseResult['db'], provider: string): string {
  const sourceId = `${provider}-calendar:work`
  const eventId = `external:${provider}`
  db.insert(calendarSources)
    .values({
      id: sourceId,
      provider,
      kind: 'calendar',
      accountId: provider === ICS_CALENDAR_PROVIDER ? null : 'acct-1',
      remoteId: `${provider}-remote-work`,
      title: 'Work',
      timezone: 'UTC',
      isSelected: true,
      syncStatus: 'ok',
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
  db.insert(calendarExternalEvents)
    .values({
      id: eventId,
      sourceId,
      remoteEventId: `${provider}-event-1`,
      title: 'Standup',
      startAt: '2026-09-24T09:00:00.000Z',
      endAt: '2026-09-24T09:30:00.000Z',
      timezone: 'UTC',
      isAllDay: false,
      status: 'confirmed',
      createdAt: NOW,
      modifiedAt: NOW
    })
    .run()
  return eventId
}

describe('provider capability table (#1391)', () => {
  it('declares Google as it behaves today: writable, push relay, synced, Memry account', () => {
    expect(PROVIDER_CAPABILITIES[GOOGLE_CALENDAR_PROVIDER]).toEqual({
      supportsWrite: true,
      supportsCreateCalendar: true,
      supportsPush: true,
      supportsMultiAccount: true,
      requiresMemryAccount: true,
      mirrorScope: 'synced',
      sourceScope: 'synced',
      incrementalMode: 'sync-token',
      authFlow: 'oauth2'
    })
  })

  it('declares ICS as it behaves today: read-only, polled, device-local mirror, no account', () => {
    expect(PROVIDER_CAPABILITIES[ICS_CALENDAR_PROVIDER]).toEqual({
      supportsWrite: false,
      supportsCreateCalendar: false,
      supportsPush: false,
      supportsMultiAccount: false,
      requiresMemryAccount: false,
      mirrorScope: 'device',
      sourceScope: 'synced',
      incrementalMode: 'conditional-get',
      authFlow: 'url'
    })
  })

  it('declares CalDAV: polled, multi-account, no Memry account, synced mirror (#1399)', () => {
    expect(PROVIDER_CAPABILITIES.caldav).toMatchObject({
      supportsPush: false,
      supportsMultiAccount: true,
      requiresMemryAccount: false,
      mirrorScope: 'synced',
      sourceScope: 'synced',
      incrementalMode: 'sync-collection',
      authFlow: 'basic',
      pollIntervalMs: 15 * 60 * 1000
    })
  })

  it('gives an unknown provider nothing writable', () => {
    expect(isKnownProvider('microsoft')).toBe(false)
    expect(providerCapabilities('microsoft')).toBe(UNKNOWN_PROVIDER_CAPABILITIES)
    expect(UNKNOWN_PROVIDER_CAPABILITIES.supportsWrite).toBe(false)
    expect(sourceCapabilities({ provider: 'google' }).supportsWrite).toBe(true)
  })

  it('keeps the shared device-local constant in step with the table', () => {
    for (const [id, capabilities] of Object.entries(PROVIDER_CAPABILITIES)) {
      expect(DEVICE_LOCAL_CALENDAR_PROVIDERS.mirrors.includes(id)).toBe(
        capabilities.mirrorScope === 'device'
      )
      expect(DEVICE_LOCAL_CALENDAR_PROVIDERS.sources.includes(id)).toBe(
        capabilities.sourceScope === 'device'
      )
      // A source row that never syncs cannot carry a synced mirror.
      if (capabilities.sourceScope === 'device') expect(capabilities.mirrorScope).toBe('device')
    }
    for (const id of DEVICE_LOCAL_CALENDAR_PROVIDERS.sources) {
      expect(DEVICE_LOCAL_CALENDAR_PROVIDERS.mirrors).toContain(id)
    }
  })

  it('treats an omitted platform list as every platform', () => {
    expect(isProviderAvailableOn({}, 'win32')).toBe(true)
    expect(isProviderAvailableOn({ platforms: ['darwin'] }, 'darwin')).toBe(true)
    expect(isProviderAvailableOn({ platforms: ['darwin'] }, 'linux')).toBe(false)
  })
})

describe('capabilities drive projection and promotion exactly as the provider compares did', () => {
  let dataDb: TestDatabaseResult
  let indexDb: TestDatabaseResult

  beforeEach(() => {
    dataDb = createTestDataDb()
    indexDb = createTestIndexDb()
  })

  afterEach(() => {
    dataDb.close()
    indexDb.close()
  })

  function editabilityFor(provider: string): unknown {
    seedExternal(dataDb.db, provider)
    const { items } = getCalendarRangeProjection(
      dataDb.db as unknown as DataDb,
      indexDb.db as unknown as IndexDb,
      {
        startAt: '2026-09-24T00:00:00.000Z',
        endAt: '2026-09-25T00:00:00.000Z',
        includeUnselectedSources: false
      },
      []
    )
    return items.find((item) => item.sourceType === 'external_event')?.editability
  }

  it('Google events stay promotable', () => {
    expect(editabilityFor(GOOGLE_CALENDAR_PROVIDER)).toEqual({
      canMove: true,
      canResize: true,
      canEditText: true,
      canDelete: true
    })
  })

  it('ICS events stay read-only', () => {
    expect(editabilityFor(ICS_CALENDAR_PROVIDER)).toEqual({
      canMove: false,
      canResize: false,
      canEditText: false,
      canDelete: false
    })
  })

  it('an unknown provider from a newer build is read-only, not promotable into Google', () => {
    expect(editabilityFor('microsoft')).toEqual({
      canMove: false,
      canResize: false,
      canEditText: false,
      canDelete: false
    })
  })

  it('promotion refuses a read-only provider and accepts Google', () => {
    const icsEvent = seedExternal(dataDb.db, ICS_CALENDAR_PROVIDER)
    expect(() =>
      promoteExternalEvent(dataDb.db as unknown as DataDb, { externalEventId: icsEvent })
    ).toThrow(ExternalEventReadOnlyError)

    const googleEvent = seedExternal(dataDb.db, GOOGLE_CALENDAR_PROVIDER)
    expect(
      promoteExternalEvent(dataDb.db as unknown as DataDb, { externalEventId: googleEvent }).success
    ).toBe(true)
  })
})
