/**
 * Shared minute tick tests
 *
 * @module main/lib/minute-tick.test
 */

import { describe, it, expect, afterEach, vi } from 'vitest'

const { loggerMock } = vi.hoisted(() => ({
  loggerMock: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn()
  }
}))

vi.mock('./logger', () => ({
  createLogger: () => loggerMock
}))

import {
  registerMinuteTick,
  unregisterMinuteTick,
  hasMinuteTick,
  isMinuteTickRunning,
  getMinuteTickIds,
  MINUTE_TICK_INTERVAL_MS
} from './minute-tick'

describe('shared minute tick', () => {
  afterEach(() => {
    for (const id of getMinuteTickIds()) unregisterMinuteTick(id)
    vi.restoreAllMocks()
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  it('drives every listener from a single 60s timer', () => {
    vi.useFakeTimers()
    const setIntervalSpy = vi.spyOn(globalThis, 'setInterval')
    const reminders = vi.fn()
    const snooze = vi.fn()
    const review = vi.fn()

    registerMinuteTick('reminders', reminders)
    registerMinuteTick('inbox-snooze', snooze)
    registerMinuteTick('inbox-review', review)

    expect(setIntervalSpy).toHaveBeenCalledTimes(1)
    expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), MINUTE_TICK_INTERVAL_MS)
    expect(getMinuteTickIds()).toEqual(['reminders', 'inbox-snooze', 'inbox-review'])

    vi.advanceTimersByTime(MINUTE_TICK_INTERVAL_MS)

    expect(reminders).toHaveBeenCalledTimes(1)
    expect(snooze).toHaveBeenCalledTimes(1)
    expect(review).toHaveBeenCalledTimes(1)
  })

  it('unrefs the timer so polling alone never holds the process open', () => {
    const nativeSetInterval = globalThis.setInterval
    let unrefSpy: ReturnType<typeof vi.fn> | null = null

    vi.spyOn(globalThis, 'setInterval').mockImplementation(((
      handler: Parameters<typeof setInterval>[0],
      ms?: number
    ) => {
      const timer = nativeSetInterval(handler, ms)
      const nativeUnref = timer.unref.bind(timer)
      unrefSpy = vi.fn(() => nativeUnref())
      timer.unref = unrefSpy as unknown as typeof timer.unref
      return timer
    }) as typeof globalThis.setInterval)

    registerMinuteTick('reminders', vi.fn())

    expect(unrefSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps ticking the other listeners when one throws', () => {
    vi.useFakeTimers()
    const boom = new Error('tick failed')
    const failing = vi.fn(() => {
      throw boom
    })
    const healthy = vi.fn()

    registerMinuteTick('inbox-snooze', failing)
    registerMinuteTick('reminders', healthy)

    expect(() => vi.advanceTimersByTime(MINUTE_TICK_INTERVAL_MS * 2)).not.toThrow()
    expect(failing).toHaveBeenCalledTimes(2)
    expect(healthy).toHaveBeenCalledTimes(2)
    expect(loggerMock.error).toHaveBeenCalledWith(
      'Minute tick listener "inbox-snooze" failed:',
      boom
    )
  })

  it('clears the timer only once the last listener unregisters', () => {
    vi.useFakeTimers()
    const reminders = vi.fn()
    const snooze = vi.fn()

    registerMinuteTick('reminders', reminders)
    registerMinuteTick('inbox-snooze', snooze)
    expect(isMinuteTickRunning()).toBe(true)

    unregisterMinuteTick('reminders')
    expect(isMinuteTickRunning()).toBe(true)
    expect(hasMinuteTick('reminders')).toBe(false)

    vi.advanceTimersByTime(MINUTE_TICK_INTERVAL_MS)
    expect(reminders).not.toHaveBeenCalled()
    expect(snooze).toHaveBeenCalledTimes(1)

    unregisterMinuteTick('inbox-snooze')
    expect(isMinuteTickRunning()).toBe(false)

    vi.advanceTimersByTime(MINUTE_TICK_INTERVAL_MS)
    expect(snooze).toHaveBeenCalledTimes(1)
  })

  it('ignores a duplicate registration for the same id', () => {
    vi.useFakeTimers()
    const first = vi.fn()
    const second = vi.fn()

    registerMinuteTick('reminders', first)
    registerMinuteTick('reminders', second)

    vi.advanceTimersByTime(MINUTE_TICK_INTERVAL_MS)

    expect(first).toHaveBeenCalledTimes(1)
    expect(second).not.toHaveBeenCalled()
    expect(loggerMock.warn).toHaveBeenCalledWith(
      'Minute tick listener "reminders" already registered'
    )
  })
})
