import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import { SettingsSyncManager } from '@memry/sync-client/settings-sync'
import type { SyncQueueManager } from '@memry/sync-client/queue'
import type { DrizzleDb } from '@memry/sync-client/drizzle-db'
import { createTestDataDb, type TestDataDb } from '../../test/helpers/test-data-db'
import { getSetting, setSetting as writeRaw } from '../database/queries/settings'
import { deleteSetting, setSetting, setSettingWriteListener } from '../settings/settings-store'
import {
  applyMergedCalendarSettings,
  changedCalendarFields,
  seedCalendarSyncedSettings,
  mirrorCalendarSettingWrite
} from './calendar-settings-sync'

vi.mock('../lib/window-broadcast', () => ({ broadcastToAllWindows: vi.fn() }))

function manager(db: TestDataDb): { sync: SettingsSyncManager; enqueue: ReturnType<typeof vi.fn> } {
  const enqueue = vi.fn()
  const queue = { enqueue } as unknown as SyncQueueManager
  return {
    sync: new SettingsSyncManager({
      db: db as unknown as DrizzleDb,
      queue,
      getDeviceId: () => null
    }),
    enqueue
  }
}

describe('calendar settings sync (spec 007 D3a)', () => {
  let db: TestDataDb

  beforeEach(() => {
    db = createTestDataDb()
  })

  afterEach(() => {
    setSettingWriteListener(null)
  })

  it('mirrors only the synced leaves a local write changed', () => {
    expect(
      changedCalendarFields(
        'calendar',
        JSON.stringify({ weekStartDay: 'monday', dayCellClickBehavior: 'journal' }),
        JSON.stringify({ weekStartDay: 'sunday', dayCellClickBehavior: 'calendar' })
      )
    ).toEqual([{ path: 'calendar.weekStartDay', value: 'sunday' }])
    expect(
      changedCalendarFields('calendar.apple-eventkit', null, '{"agentReadEventsConsent":true}')
    ).toEqual([])
    expect(
      changedCalendarFields('calendar.caldav', null, '{"pushEventsToProvider":false}')
    ).toEqual([{ path: 'calendar.caldav.pushEventsToProvider', value: false }])
    expect(
      changedCalendarFields(
        'calendar.defaultWriteTarget',
        '{"provider":"caldav","remoteCalendarId":"x"}',
        null
      )
    ).toEqual([{ path: 'calendar.defaultWriteTarget', value: null }])
  })

  it('a first write of a group syncs only what moved off the defaults', () => {
    // Saving one field writes the whole group. On a device with no stored
    // row, the defaults it carries are not changes and must not overwrite
    // another device's real values (e.g. onboardingCompleted).
    expect(
      changedCalendarFields(
        'calendar.google',
        null,
        JSON.stringify({
          defaultTargetCalendarId: null,
          onboardingCompleted: false,
          promoteConfirmDismissed: true,
          pushEventsToGoogle: true,
          agentReadEventsConsent: null
        })
      )
    ).toEqual([{ path: 'calendar.google.promoteConfirmDismissed', value: true }])
    expect(
      changedCalendarFields(
        'calendar',
        null,
        JSON.stringify({ weekStartDay: 'monday', showNotesOnCalendar: true })
      )
    ).toEqual([{ path: 'calendar.showNotesOnCalendar', value: true }])
  })

  it('pushes every writer of a calendar group through settings sync', () => {
    const { sync, enqueue } = manager(db)
    setSettingWriteListener((_db, key, before, after) =>
      mirrorCalendarSettingWrite(sync, key, before, after)
    )
    setSetting(
      db,
      'calendar.google',
      JSON.stringify({ pushEventsToGoogle: false, promoteConfirmDismissed: true })
    )
    expect(sync.getSettings().calendar?.google).toEqual({
      pushEventsToGoogle: false,
      promoteConfirmDismissed: true
    })
    setSetting(
      db,
      'calendar.defaultWriteTarget',
      JSON.stringify({ provider: 'caldav', remoteCalendarId: 'work' })
    )
    deleteSetting(db, 'calendar.defaultWriteTarget')
    expect(sync.getSettings().calendar?.defaultWriteTarget).toBeNull()
    // Rewriting the same value ticks nothing.
    const before = enqueue.mock.calls.length
    setSetting(
      db,
      'calendar.google',
      JSON.stringify({ pushEventsToGoogle: false, promoteConfirmDismissed: true })
    )
    expect(enqueue.mock.calls.length).toBe(before)
  })

  it('seeds a local value once, and never over a value some device synced', () => {
    writeRaw(db, 'calendar', JSON.stringify({ weekStartDay: 'sunday', showNotesOnCalendar: true }))
    const { sync } = manager(db)
    sync.mergeRemote({
      settings: { calendar: { weekStartDay: 'monday' } },
      fieldClocks: { 'calendar.weekStartDay': { desktopB: 1 } }
    })
    expect(seedCalendarSyncedSettings(db, sync)).toBe(1)
    expect(sync.getSettings().calendar).toEqual({
      weekStartDay: 'monday',
      showNotesOnCalendar: true
    })
    expect(seedCalendarSyncedSettings(db, sync)).toBe(0)
  })

  it('an old-schema upload does not clobber a key it does not know', () => {
    const { sync } = manager(db)
    sync.updateField('calendar.showNotesOnCalendar', true, 'phone')
    // An older desktop strips the key from `settings` but keeps its clock.
    sync.mergeRemote({
      settings: { calendar: { weekStartDay: 'monday' } },
      fieldClocks: {
        'calendar.showNotesOnCalendar': { phone: 1 },
        'calendar.weekStartDay': { old: 1 }
      }
    })
    expect(sync.getSettings().calendar).toEqual({
      showNotesOnCalendar: true,
      weekStartDay: 'monday'
    })
    // And one that never saw the key at all.
    sync.mergeRemote({ settings: { calendar: {} }, fieldClocks: {} })
    expect(sync.getSettings().calendar?.showNotesOnCalendar).toBe(true)
  })

  it('merges concurrent edits per key', () => {
    const { sync } = manager(db)
    sync.updateField('calendar.google.pushEventsToGoogle', false, 'phone')
    sync.mergeRemote({
      settings: { calendar: { google: { promoteConfirmDismissed: true } } },
      fieldClocks: { 'calendar.google.promoteConfirmDismissed': { desktop: 1 } }
    })
    expect(sync.getSettings().calendar?.google).toEqual({
      pushEventsToGoogle: false,
      promoteConfirmDismissed: true
    })
  })

  it('writes merged values into the local groups without echoing them back', () => {
    const { sync, enqueue } = manager(db)
    setSettingWriteListener((_db, key, before, after) =>
      mirrorCalendarSettingWrite(sync, key, before, after)
    )
    writeRaw(db, 'calendar', JSON.stringify({ dayCellClickBehavior: 'calendar' }))
    writeRaw(
      db,
      'calendar.defaultWriteTarget',
      JSON.stringify({ provider: 'caldav', remoteCalendarId: 'x' })
    )
    const before = enqueue.mock.calls.length
    applyMergedCalendarSettings(db, {
      showNotesOnCalendar: true,
      defaultWriteTarget: null,
      google: { agentReadEventsConsent: true },
      caldav: { pushEventsToProvider: false }
    })
    expect(JSON.parse(getSetting(db, 'calendar') ?? '{}')).toEqual({
      dayCellClickBehavior: 'calendar',
      showNotesOnCalendar: true
    })
    expect(JSON.parse(getSetting(db, 'calendar.google') ?? '{}')).toEqual({
      agentReadEventsConsent: true
    })
    expect(JSON.parse(getSetting(db, 'calendar.caldav') ?? '{}')).toEqual({
      pushEventsToProvider: false
    })
    expect(getSetting(db, 'calendar.defaultWriteTarget')).toBeNull()
    expect(enqueue.mock.calls.length).toBe(before)
  })
})
