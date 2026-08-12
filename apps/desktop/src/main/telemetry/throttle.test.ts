import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { resetTelemetryThrottle, shouldEmitThrottled, telemetryThrottleKeyCount } from './throttle'

// Mirrors MAX_TRACKED_KEYS in throttle.ts, which stays module-private.
const MAX_TRACKED_KEYS = 1000

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

  it('bounds the map when distinct keys burst inside one window', () => {
    // #given keys are per-document, so a vault import or a writeback pass can
    // put far more than MAX_TRACKED_KEYS live keys in the map inside one window
    // #when 1200 distinct notes are touched without the window ever elapsing
    for (let i = 0; i < 1200; i++) {
      shouldEmitThrottled(`note_updated:${i}`)
    }

    // #then the map never exceeds the cap — the sweep found nothing expired,
    // so oldest-inserted keys were dropped to keep the bound hard
    expect(telemetryThrottleKeyCount()).toBeLessThanOrEqual(MAX_TRACKED_KEYS)
  })

  it('releases keys whose window has elapsed once the cap is crossed', () => {
    // #given a full map of keys that have all aged out
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) {
      shouldEmitThrottled(`note_updated:${i}`)
    }
    vi.advanceTimersByTime(5 * 60 * 1000 + 1)

    // #when one more key crosses the cap
    shouldEmitThrottled('note_updated:trigger')

    // #then every expired key is released, leaving only the live one
    expect(telemetryThrottleKeyCount()).toBe(1)
  })

  it('does not let a short-window caller evict long-window entries', () => {
    // #given a full map of default 5-minute entries (note_updated:*)
    for (let i = 0; i < MAX_TRACKED_KEYS; i++) {
      shouldEmitThrottled(`note_updated:${i}`)
    }
    // #and 61s pass — past a 60s window, well inside the 5-minute one
    vi.advanceTimersByTime(61_000)

    // #when a 60s caller (google-sync-runner) crosses the cap
    expect(shouldEmitThrottled('calendar_google_sync_failed:push', 60_000)).toBe(true)

    // #then the 5-minute entries are still throttled: expiry is judged per
    // entry's own window, not by whichever call happened to trigger the sweep
    expect(shouldEmitThrottled(`note_updated:${MAX_TRACKED_KEYS - 1}`)).toBe(false)
    expect(telemetryThrottleKeyCount()).toBe(MAX_TRACKED_KEYS)
  })
})
