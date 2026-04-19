import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  BrowserWindow: { getAllWindows: vi.fn(() => []) }
}))

vi.mock('./oauth', () => ({
  hasGoogleCalendarConnection: vi.fn(async () => true),
  hasGoogleCalendarLocalAuth: vi.fn(async () => true)
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

vi.mock('../../database', () => ({
  requireDatabase: vi.fn(() => ({}) as unknown as object),
  getDatabase: vi.fn(() => ({}) as unknown as object),
  isDatabaseInitialized: vi.fn(() => true)
}))

import {
  PUSH_BACKOFF_INTERVAL_MS,
  getCurrentPollIntervalMs,
  reEvaluatePollCadence,
  startGoogleCalendarSyncRunner,
  stopGoogleCalendarSyncRunner
} from './sync-service'

const RUN_INTERVAL_MS = 5 * 60 * 1000

describe('reEvaluatePollCadence (Task 10 — push-channel poll backoff)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    stopGoogleCalendarSyncRunner()
    // Reset back to default cadence between cases.
    reEvaluatePollCadence(0)
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('defaults to RUN_INTERVAL_MS (5 minutes) before any push channels are active', () => {
    // #given no reEvaluate has been called
    // #then the runner's poll cadence is 5 minutes
    expect(getCurrentPollIntervalMs()).toBe(RUN_INTERVAL_MS)
  })

  it('switches to PUSH_BACKOFF_INTERVAL_MS (30 minutes) when at least one channel is active', () => {
    // #when a push channel comes online
    reEvaluatePollCadence(1)

    // #then the poll falls back to 30 minutes (push is primary, polling is safety net)
    expect(getCurrentPollIntervalMs()).toBe(PUSH_BACKOFF_INTERVAL_MS)
    expect(PUSH_BACKOFF_INTERVAL_MS).toBe(30 * 60 * 1000)
  })

  it('restores RUN_INTERVAL_MS the moment every channel is gone', () => {
    // #given two channels were active
    reEvaluatePollCadence(2)

    // #when all channels go down
    reEvaluatePollCadence(0)

    // #then the poll resumes its 5-minute cadence
    expect(getCurrentPollIntervalMs()).toBe(RUN_INTERVAL_MS)
  })

  it('is idempotent when the count stays > 0 (no interval churn between 1 and N channels)', () => {
    reEvaluatePollCadence(1)
    reEvaluatePollCadence(5)
    reEvaluatePollCadence(3)

    expect(getCurrentPollIntervalMs()).toBe(PUSH_BACKOFF_INTERVAL_MS)
  })

  it('re-arms the live setInterval when a runner is active', async () => {
    // #given spies around the timer APIs
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    // #given the runner is started (eager sync is best-effort and tolerates failure)
    await startGoogleCalendarSyncRunner()

    // #then the initial setInterval was scheduled at RUN_INTERVAL_MS
    const firstCall = setIntervalSpy.mock.calls.find((call) => call[1] === RUN_INTERVAL_MS)
    expect(firstCall).toBeTruthy()

    setIntervalSpy.mockClear()
    clearIntervalSpy.mockClear()

    // #when a push channel comes online
    reEvaluatePollCadence(1)

    // #then the old interval is cleared and a new one is armed at the backoff cadence
    expect(clearIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), PUSH_BACKOFF_INTERVAL_MS)
  })

  it('does not re-arm when no runner is active (prevents phantom timers)', () => {
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const clearIntervalSpy = vi.spyOn(globalThis, 'clearInterval')

    reEvaluatePollCadence(1)

    expect(clearIntervalSpy).not.toHaveBeenCalled()
    expect(setIntervalSpy).not.toHaveBeenCalled()
    // But the cadence value IS updated — when the runner eventually starts it will pick the right cadence.
    expect(getCurrentPollIntervalMs()).toBe(PUSH_BACKOFF_INTERVAL_MS)
  })
})
