export const TELEMETRY_THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED_KEYS = 1000

const lastEmitted = new Map<string, number>()

/**
 * Returns true when an event for this key should be emitted, false while a
 * previous emission is still inside the throttle window. In-memory only —
 * the window intentionally resets on app restart.
 */
export const shouldEmitThrottled = (
  key: string,
  windowMs: number = TELEMETRY_THROTTLE_WINDOW_MS
): boolean => {
  const now = Date.now()
  const last = lastEmitted.get(key)
  if (last !== undefined && now - last < windowMs) return false
  lastEmitted.set(key, now)
  if (lastEmitted.size > MAX_TRACKED_KEYS) {
    for (const [trackedKey, emittedAt] of lastEmitted) {
      if (now - emittedAt >= windowMs) lastEmitted.delete(trackedKey)
    }
  }
  return true
}

export const resetTelemetryThrottle = (): void => {
  lastEmitted.clear()
}
