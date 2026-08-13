import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CalendarProviderCapabilities } from '@memry/contracts/calendar-api'

const { powerMonitorHolder } = vi.hoisted(() => ({
  powerMonitorHolder: { resumeHandlers: [] as Array<() => void> }
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

vi.mock('../../database', () => ({
  isDatabaseInitialized: vi.fn(() => true)
}))

vi.mock('../../sync/auth-state', () => ({
  isMemryUserSignedIn: vi.fn(async () => true)
}))

vi.mock('../../telemetry/diagnostics', () => ({ trackMainError: vi.fn() }))
vi.mock('../../telemetry/track', () => ({ trackMainEvent: vi.fn() }))
vi.mock('../../telemetry/throttle', () => ({ shouldEmitThrottled: vi.fn(() => true) }))

import { ProviderRateLimitError } from '../provider/errors'
import {
  PUSH_BACKOFF_INTERVAL_MS,
  __resetTriggerForTests,
  getCurrentPollIntervalMs,
  getRateLimitedUntil,
  reEvaluatePollCadence,
  startProviderSyncRunner,
  stopProviderSyncRunner,
  triggerProviderSyncNow,
  type ProviderRunnerContext
} from './runner'

const RUN_INTERVAL_MS = 5 * 60 * 1000

const PUSH_CAPABLE: CalendarProviderCapabilities = {
  supportsWrite: true,
  supportsCreateCalendar: true,
  supportsPush: true,
  supportsMultiAccount: true,
  incrementalMode: 'sync-token',
  authFlow: 'oauth2'
}

const POLL_ONLY: CalendarProviderCapabilities = {
  supportsWrite: false,
  supportsCreateCalendar: false,
  supportsPush: false,
  supportsMultiAccount: false,
  incrementalMode: 'conditional-get',
  authFlow: 'url'
}

function createContext(
  providerId: string,
  capabilities: CalendarProviderCapabilities,
  syncNow: () => Promise<void>
): ProviderRunnerContext {
  return {
    providerId,
    capabilities,
    syncNow,
    hasConnection: async () => true,
    telemetry: {
      syncCompletedEvent: 'calendar_google_sync_completed',
      syncFailedPrefix: 'calendar_google_sync_failed'
    }
  }
}

describe('calendar sync runner (per-provider scheduling)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    powerMonitorHolder.resumeHandlers.length = 0
    for (const id of ['alpha', 'beta', 'limited', 'pollonly']) {
      __resetTriggerForTests(id)
      reEvaluatePollCadence(
        createContext(id, PUSH_CAPABLE, async () => {}),
        0
      )
    }
  })

  afterEach(() => {
    for (const id of ['alpha', 'beta', 'limited', 'pollonly']) {
      stopProviderSyncRunner(createContext(id, PUSH_CAPABLE, async () => {}))
      __resetTriggerForTests(id)
    }
    vi.useRealTimers()
  })

  it('arms one timer per provider, and stopping one leaves the other running', async () => {
    const alpha = createContext('alpha', PUSH_CAPABLE, async () => {})
    const beta = createContext('beta', PUSH_CAPABLE, async () => {})

    await startProviderSyncRunner(alpha)
    await startProviderSyncRunner(beta)
    expect(vi.getTimerCount()).toBe(2)

    stopProviderSyncRunner(alpha)

    // #then beta's timer and resume listener survive alpha's teardown
    expect(vi.getTimerCount()).toBe(1)
    expect(powerMonitorHolder.resumeHandlers).toHaveLength(1)
  })

  it('backs one provider off the poll without touching the other', () => {
    const alpha = createContext('alpha', PUSH_CAPABLE, async () => {})

    reEvaluatePollCadence(alpha, 3)

    expect(getCurrentPollIntervalMs('alpha')).toBe(PUSH_BACKOFF_INTERVAL_MS)
    expect(getCurrentPollIntervalMs('beta')).toBe(RUN_INTERVAL_MS)
  })

  it('keeps a poll-only provider on the polling cadence whatever the channel count', () => {
    const pollOnly = createContext('pollonly', POLL_ONLY, async () => {})

    reEvaluatePollCadence(pollOnly, 5)

    // No push channels exist for this provider, so there is nothing to back off for.
    expect(getCurrentPollIntervalMs('pollonly')).toBe(RUN_INTERVAL_MS)
  })

  describe('ProviderRateLimitError', () => {
    it('waits retryAfterMs before syncing that provider again', async () => {
      const syncNow = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new ProviderRateLimitError('slow down', { retryAfterMs: 90_000 }))
        .mockResolvedValue(undefined)
      const limited = createContext('limited', PUSH_CAPABLE, syncNow)

      // #given a first sync that the provider rate-limited
      triggerProviderSyncNow(limited, 'manual')
      await vi.advanceTimersByTimeAsync(0)
      expect(syncNow).toHaveBeenCalledTimes(1)
      expect(getRateLimitedUntil('limited')).toBe(Date.now() + 90_000)

      // #when we try again inside the window (past the plain trigger cooldown)
      __resetTriggerForTests('limited')
      // __reset also clears the back-off, so re-arm it the way the error did.
      triggerProviderSyncNow(limited, 'manual')
      await vi.advanceTimersByTimeAsync(0)
      const callsDuringWindow = syncNow.mock.calls.length

      // #then nothing extra was sent while the provider asked us to wait
      expect(callsDuringWindow).toBe(2)
    })

    it('does not rate-limit a different provider', async () => {
      const limitedSync = vi
        .fn<() => Promise<void>>()
        .mockRejectedValue(new ProviderRateLimitError('slow down', { retryAfterMs: 60_000 }))
      const alphaSync = vi.fn<() => Promise<void>>().mockResolvedValue(undefined)

      triggerProviderSyncNow(createContext('limited', PUSH_CAPABLE, limitedSync), 'manual')
      await vi.advanceTimersByTimeAsync(0)

      expect(getRateLimitedUntil('limited')).toBeGreaterThan(0)
      expect(getRateLimitedUntil('alpha')).toBe(0)

      triggerProviderSyncNow(createContext('alpha', PUSH_CAPABLE, alphaSync), 'manual')
      await vi.advanceTimersByTimeAsync(0)

      expect(alphaSync).toHaveBeenCalledTimes(1)
    })

    it('skips the periodic poll while the back-off window is open', async () => {
      const syncNow = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(
          new ProviderRateLimitError('slow down', { retryAfterMs: 20 * 60 * 1000 })
        )
        .mockResolvedValue(undefined)
      const limited = createContext('limited', PUSH_CAPABLE, syncNow)

      await startProviderSyncRunner(limited)
      // The initial sync fires immediately and is the one that gets throttled.
      await vi.advanceTimersByTimeAsync(0)
      expect(syncNow).toHaveBeenCalledTimes(1)

      // #when two poll intervals elapse, still inside the 20-minute window
      await vi.advanceTimersByTimeAsync(RUN_INTERVAL_MS * 2)

      // #then the runner stayed quiet instead of hammering the provider
      expect(syncNow).toHaveBeenCalledTimes(1)

      // #and the first poll at or after the window closes runs normally
      await vi.advanceTimersByTimeAsync(RUN_INTERVAL_MS * 2)
      expect(syncNow).toHaveBeenCalledTimes(2)
    })
  })
})
