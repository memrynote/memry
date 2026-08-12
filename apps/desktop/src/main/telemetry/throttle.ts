export const TELEMETRY_THROTTLE_WINDOW_MS = 5 * 60 * 1000
const MAX_TRACKED_KEYS = 1000

// The window each entry was recorded under travels with the entry. Callers pass
// their own `windowMs` (60s in google-sync-runner, the 5-minute default for
// `note_updated`/`journal_updated`), and the sweep below runs on whichever call
// happens to cross the cap — keying expiry off the *sweeping* call's window
// would let a 60s caller drop a still-live 5-minute entry and re-emit it.
type ThrottleEntry = { emittedAt: number; windowMs: number }

const lastEmitted = new Map<string, ThrottleEntry>()

const sweepTrackedKeys = (now: number): void => {
  if (lastEmitted.size <= MAX_TRACKED_KEYS) return
  for (const [trackedKey, entry] of lastEmitted) {
    if (now - entry.emittedAt >= entry.windowMs) lastEmitted.delete(trackedKey)
  }
  // Keys are per-document (`note_updated:${id}`, `journal_updated:${date}`), so
  // more than MAX distinct keys inside one window is ordinary — a vault import
  // or a writeback pass. With nothing expired the sweep above deletes nothing,
  // so the oldest-inserted keys are dropped to keep the bound hard. Dropping a
  // key only forfeits its throttle, never an event.
  for (const trackedKey of lastEmitted.keys()) {
    if (lastEmitted.size <= MAX_TRACKED_KEYS) break
    lastEmitted.delete(trackedKey)
  }
}

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
  if (last !== undefined && now - last.emittedAt < windowMs) return false
  lastEmitted.set(key, { emittedAt: now, windowMs })
  sweepTrackedKeys(now)
  return true
}

/**
 * Number of live throttle keys. Exported so the memory bound is directly
 * assertable in tests; production code never reads it.
 */
export const telemetryThrottleKeyCount = (): number => lastEmitted.size

export const resetTelemetryThrottle = (): void => {
  lastEmitted.clear()
}
