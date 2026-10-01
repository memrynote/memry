import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { MAX_STALL_REPORTS, STALL_TICK_MS, startMainThreadStallMonitor } from './main-thread-stall'

const { scopedLogger, powerListeners, powerMonitor, latestLaunchPhaseMock } = vi.hoisted(() => {
  const powerListeners = new Map<string, Set<() => void>>()
  return {
    scopedLogger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
    powerListeners,
    powerMonitor: {
      on: (event: string, listener: () => void): void => {
        const set = powerListeners.get(event) ?? new Set<() => void>()
        set.add(listener)
        powerListeners.set(event, set)
      },
      removeListener: (event: string, listener: () => void): void => {
        powerListeners.get(event)?.delete(listener)
      }
    },
    latestLaunchPhaseMock: vi.fn<() => string | null>(() => null)
  }
})

const emitPower = (event: 'suspend' | 'resume'): void => {
  for (const listener of powerListeners.get(event) ?? []) listener()
}

vi.mock('./lib/logger', () => ({
  createLogger: vi.fn(() => scopedLogger)
}))

vi.mock('electron', () => ({ powerMonitor }))

vi.mock('./launch-timeline', () => ({
  latestLaunchPhase: latestLaunchPhaseMock
}))

const START = new Date('2026-09-30T10:00:00.000Z').getTime()

// Fake timers advance Date.now in step with the interval, so a healthy loop
// reads zero drift. Jumping the system clock before a tick is what a blocked
// loop looks like: the tick fires that much later than scheduled.
function blockLoopFor(ms: number): void {
  vi.setSystemTime(Date.now() + ms)
  vi.advanceTimersByTime(STALL_TICK_MS)
}

describe('main thread stall monitor', () => {
  let stop: (() => void) | null = null

  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(START)
    scopedLogger.warn.mockClear()
    latestLaunchPhaseMock.mockReturnValue(null)
  })

  afterEach(() => {
    stop?.()
    stop = null
    vi.useRealTimers()
  })

  it('stays quiet while the loop ticks on time', () => {
    stop = startMainThreadStallMonitor()
    vi.advanceTimersByTime(STALL_TICK_MS * 30)
    expect(scopedLogger.warn).not.toHaveBeenCalled()
  })

  it('reports a blocked loop with its duration and the launch phase it interrupted', () => {
    stop = startMainThreadStallMonitor()
    latestLaunchPhaseMock.mockReturnValue('vault_open_start')

    blockLoopFor(7_000)

    expect(scopedLogger.warn).toHaveBeenCalledTimes(1)
    expect(scopedLogger.warn).toHaveBeenCalledWith('main thread stalled', {
      durationMs: 7_000,
      phase: 'vault_open_start',
      count: 1
    })
  })

  it('names the stall "startup" before the first launch phase', () => {
    stop = startMainThreadStallMonitor()
    blockLoopFor(3_000)
    expect(scopedLogger.warn).toHaveBeenCalledWith(
      'main thread stalled',
      expect.objectContaining({ phase: 'startup' })
    )
  })

  it('ignores delays under the threshold', () => {
    stop = startMainThreadStallMonitor()
    blockLoopFor(1_500)
    expect(scopedLogger.warn).not.toHaveBeenCalled()
  })

  it('does not report system sleep as a stall', () => {
    stop = startMainThreadStallMonitor()
    emitPower('suspend')
    // The wake tick can run before the resume event arrives.
    blockLoopFor(60_000)
    emitPower('resume')
    vi.advanceTimersByTime(STALL_TICK_MS * 5)
    expect(scopedLogger.warn).not.toHaveBeenCalled()

    blockLoopFor(4_000)
    expect(scopedLogger.warn).toHaveBeenCalledTimes(1)
  })

  it('caps the number of reports per run', () => {
    stop = startMainThreadStallMonitor()
    for (let i = 0; i < MAX_STALL_REPORTS + 5; i += 1) blockLoopFor(3_000)
    expect(scopedLogger.warn).toHaveBeenCalledTimes(MAX_STALL_REPORTS)
  })

  it('stops ticking and detaches its power listeners when stopped', () => {
    startMainThreadStallMonitor()()
    expect(powerListeners.get('suspend')?.size ?? 0).toBe(0)
    expect(powerListeners.get('resume')?.size ?? 0).toBe(0)
    blockLoopFor(5_000)
    expect(scopedLogger.warn).not.toHaveBeenCalled()
  })
})
