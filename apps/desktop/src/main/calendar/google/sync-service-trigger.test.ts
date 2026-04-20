import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDbHolder, powerMonitorHolder, syncNowMock } = vi.hoisted(() => ({
  mockDbHolder: { db: null as object | null },
  powerMonitorHolder: {
    resumeHandlers: [] as Array<() => void>,
    on: vi.fn(),
    removeListener: vi.fn()
  },
  syncNowMock: vi.fn(async () => {})
}))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: {
    on: (event: string, cb: () => void) => {
      if (event === 'resume') powerMonitorHolder.resumeHandlers.push(cb)
      powerMonitorHolder.on(event, cb)
    },
    removeListener: (event: string, cb: () => void) => {
      if (event === 'resume') {
        const index = powerMonitorHolder.resumeHandlers.indexOf(cb)
        if (index >= 0) powerMonitorHolder.resumeHandlers.splice(index, 1)
      }
      powerMonitorHolder.removeListener(event, cb)
    }
  }
}))

vi.mock('./oauth', () => ({
  hasGoogleCalendarConnection: vi.fn(async () => true),
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  listGoogleAccountIds: vi.fn(() => []),
  resolveDefaultGoogleAccountId: vi.fn(() => null)
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

vi.mock('../../database', () => ({
  requireDatabase: vi.fn(() => mockDbHolder.db),
  getDatabase: vi.fn(() => mockDbHolder.db),
  isDatabaseInitialized: vi.fn(() => true)
}))

vi.mock('./sync-service', async () => {
  const actual = await vi.importActual<typeof import('./sync-service')>('./sync-service')
  return {
    ...actual,
    syncGoogleCalendarNow: syncNowMock
  }
})

import {
  __resetTriggerForTests,
  triggerGoogleCalendarSyncNow,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner
} from './google-sync-runner'
import { createTestDataDb, type TestDatabaseResult } from '@tests/utils/test-db'

describe('triggerGoogleCalendarSyncNow (focus/resume/manual refresh)', () => {
  let dbResult: TestDatabaseResult

  beforeEach(() => {
    dbResult = createTestDataDb()
    mockDbHolder.db = dbResult.db
    __resetTriggerForTests()
    syncNowMock.mockClear()
    powerMonitorHolder.resumeHandlers.length = 0
    powerMonitorHolder.on.mockClear()
    powerMonitorHolder.removeListener.mockClear()
  })

  afterEach(() => {
    stopGoogleCalendarSyncRunner()
    vi.restoreAllMocks()
    dbResult.close()
    mockDbHolder.db = null
  })

  it('fires an immediate sync on first call', async () => {
    // #when the trigger is called once
    triggerGoogleCalendarSyncNow('window-focus')

    // #then a sync kicks off
    await Promise.resolve()
    expect(syncNowMock).toHaveBeenCalledTimes(1)
  })

  it('skips sync on rapid consecutive calls within the cooldown window', async () => {
    // #given the trigger just fired
    triggerGoogleCalendarSyncNow('window-focus')
    await Promise.resolve()

    // #when called again 100 ms later
    triggerGoogleCalendarSyncNow('resume')
    triggerGoogleCalendarSyncNow('manual')
    await Promise.resolve()

    // #then the extra calls are skipped
    expect(syncNowMock).toHaveBeenCalledTimes(1)
  })

  it('fires again after the cooldown window elapses', async () => {
    // #given a trigger already fired at t=0
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
    triggerGoogleCalendarSyncNow('window-focus')
    await Promise.resolve()

    // #when time advances past the 10-second cooldown
    vi.setSystemTime(new Date('2026-01-01T00:00:11Z'))
    triggerGoogleCalendarSyncNow('window-focus')
    await Promise.resolve()

    // #then a second sync fires
    expect(syncNowMock).toHaveBeenCalledTimes(2)
    vi.useRealTimers()
  })

  it('swallows sync errors so focus/resume handlers never crash', async () => {
    // #given syncGoogleCalendarNow rejects
    syncNowMock.mockRejectedValueOnce(new Error('network down'))

    // #when the trigger is called
    expect(() => triggerGoogleCalendarSyncNow('resume')).not.toThrow()

    // #then the rejection is caught (no unhandled rejection)
    await Promise.resolve()
    await Promise.resolve()
    expect(syncNowMock).toHaveBeenCalledTimes(1)
  })

  it('registers a powerMonitor resume handler when the runner starts', async () => {
    // #when the runner starts
    await startGoogleCalendarSyncRunner()

    // #then a resume listener is wired
    expect(powerMonitorHolder.on).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)
  })

  it('detaches the powerMonitor resume handler when the runner stops', async () => {
    // #given the runner is running
    await startGoogleCalendarSyncRunner()
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)

    // #when it stops
    stopGoogleCalendarSyncRunner()

    // #then the listener is removed
    expect(powerMonitorHolder.removeListener).toHaveBeenCalledWith('resume', expect.any(Function))
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(0)
  })

  it('triggers sync when powerMonitor resume fires (after cooldown from boot)', async () => {
    // #given the runner is started (initial eager sync consumes the first slot)
    await startGoogleCalendarSyncRunner()
    syncNowMock.mockClear()
    __resetTriggerForTests()

    // #when the OS emits a resume event
    const handler = powerMonitorHolder.resumeHandlers[0]
    expect(handler).toBeDefined()
    handler!()

    // #then a sync kicks off immediately
    await Promise.resolve()
    expect(syncNowMock).toHaveBeenCalledTimes(1)
  })
})
