import { RateLimitError } from '@memry/sync-client/http-errors'

const START_INTERVAL_MS = 250 // Leave headroom under the shared 300 requests/minute budget.
const MAX_ACTIVE = 2
let active = 0
let nextStartAt = 0
let cooldownUntil = 0

/** Also consulted before the outbox reads/merges another note's queued rows. */
export function crdtPushDelayMs(): number {
  return Math.max(
    0,
    nextStartAt - Date.now(),
    cooldownUntil - Date.now(),
    active >= MAX_ACTIVE ? START_INTERVAL_MS : 0
  )
}

/** Fail fast: ownership and retry stay with the durable outbox/snapshot caller. */
export function admitCrdtPush(): () => void {
  const delayMs = crdtPushDelayMs()
  if (delayMs > 0) throw new RateLimitError(delayMs / 1000)
  active++
  nextStartAt = Date.now() + START_INTERVAL_MS
  return () => {
    active--
  }
}

/** Called on the raw HTTP 429, before auth/retry wrappers can transform it. */
export function holdCrdtPushes(error: RateLimitError): void {
  cooldownUntil = Math.max(cooldownUntil, Date.now() + error.retryAfterMs)
}
