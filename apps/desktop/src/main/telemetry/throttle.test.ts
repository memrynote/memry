import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetTelemetryThrottle, shouldEmitThrottled } from './throttle'

describe('shouldEmitThrottled', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    resetTelemetryThrottle()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('emits the first event for a key', () => {
    expect(shouldEmitThrottled('note_updated:abc')).toBe(true)
  })

  it('suppresses repeats inside the window', () => {
    shouldEmitThrottled('note_updated:abc')
    vi.advanceTimersByTime(4 * 60 * 1000)
    expect(shouldEmitThrottled('note_updated:abc')).toBe(false)
  })

  it('emits again after the window', () => {
    shouldEmitThrottled('note_updated:abc')
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)
    expect(shouldEmitThrottled('note_updated:abc')).toBe(true)
  })

  it('tracks keys independently', () => {
    shouldEmitThrottled('note_updated:abc')
    expect(shouldEmitThrottled('note_updated:def')).toBe(true)
  })
})
