import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { mockDbHolder, powerMonitorHolder, syncNowMock, signedInMock, hasConnectionMock } =
  vi.hoisted(() => ({
    mockDbHolder: { db: {} as object },
    powerMonitorHolder: {
      resumeHandlers: [] as Array<() => void>
    },
    syncNowMock: vi.fn(async () => {}),
    signedInMock: vi.fn(async () => true),
    hasConnectionMock: vi.fn(async () => true)
  }))

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
  powerMonitor: {
    on: (event: string, cb: () => void) => {
      if (event === 'resume') powerMonitorHolder.resumeHandlers.push(cb)
    },
    removeListener: (event: string, cb: () => void) => {
      if (event === 'resume') {
        const index = powerMonitorHolder.resumeHandlers.indexOf(cb)
        if (index >= 0) powerMonitorHolder.resumeHandlers.splice(index, 1)
      }
    }
  }
}))

vi.mock('./oauth', () => ({
  hasGoogleCalendarConnection: hasConnectionMock,
  hasGoogleCalendarLocalAuth: vi.fn(async () => true),
  listGoogleAccountIds: vi.fn(() => []),
  resolveDefaultGoogleAccountId: vi.fn(() => null)
}))

vi.mock('../../../sync/auth-state', () => ({
  isMemryUserSignedIn: signedInMock
}))

vi.mock('../../../database', () => ({
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

import { startGoogleCalendarSyncRunner, stopGoogleCalendarSyncRunner } from './google-sync-runner'

describe('startGoogleCalendarSyncRunner (concurrent start)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    powerMonitorHolder.resumeHandlers.length = 0
    syncNowMock.mockClear()
    signedInMock.mockClear()
    hasConnectionMock.mockClear()
  })

  afterEach(() => {
    stopGoogleCalendarSyncRunner()
    vi.useRealTimers()
  })

  it('arms exactly one interval and one resume listener when two callers start concurrently', async () => {
    // #given two overlapping callers (app startup + sign-in / connect-account)
    // #when both call start before the sign-in / connection awaits resolve
    await Promise.all([startGoogleCalendarSyncRunner(), startGoogleCalendarSyncRunner()])

    // #then only one poll timer and one powerMonitor resume listener exist
    expect(vi.getTimerCount()).toBe(1)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)
  })

  it('leaves nothing running after stop when the start calls raced', async () => {
    // #given two callers raced the runner into life
    await Promise.all([startGoogleCalendarSyncRunner(), startGoogleCalendarSyncRunner()])

    // #when the runner is stopped (sign-out / disconnect / app quit)
    stopGoogleCalendarSyncRunner()

    // #then no orphaned timer or listener survives
    expect(vi.getTimerCount()).toBe(0)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(0)
  })

  it('can be restarted after stop (the in-flight latch clears)', async () => {
    // #given a full start/stop cycle
    await startGoogleCalendarSyncRunner()
    stopGoogleCalendarSyncRunner()

    // #when the runner starts again
    await startGoogleCalendarSyncRunner()

    // #then it is live again with a single timer and listener
    expect(vi.getTimerCount()).toBe(1)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)
  })

  it('installs nothing when stop() ran while the start was still in flight', async () => {
    // #given a start that is parked on its connection check (sign-in / device
    // registration kicked it off just before the user signed out)
    let releaseConnectionCheck: () => void = () => {}
    const reachedConnectionCheck = new Promise<void>((entered) => {
      hasConnectionMock.mockImplementationOnce(
        () =>
          new Promise<boolean>((resolve) => {
            releaseConnectionCheck = () => resolve(true)
            entered()
          })
      )
    })
    const pending = startGoogleCalendarSyncRunner()
    await reachedConnectionCheck

    // #when the runner is stopped before that start finishes, then it resolves
    stopGoogleCalendarSyncRunner()
    releaseConnectionCheck()
    await pending

    // #then the stopped runner stays stopped — no timer, no resume listener
    expect(vi.getTimerCount()).toBe(0)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(0)
  })

  it('does not latch permanently when the start attempt bails out', async () => {
    // #given the user is not signed in yet
    signedInMock.mockResolvedValueOnce(false)
    await startGoogleCalendarSyncRunner()
    expect(vi.getTimerCount()).toBe(0)

    // #when they sign in and start is called again
    await startGoogleCalendarSyncRunner()

    // #then the runner actually starts
    expect(vi.getTimerCount()).toBe(1)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)
  })
})
