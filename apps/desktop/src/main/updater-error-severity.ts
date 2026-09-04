// Which updater failures are defects and which are just "this laptop is on a
// train". Every electron-updater `error` event used to become an `app_error_seen`
// exception, so ordinary connectivity drops made the updater the second-largest
// error source in the product — 33.2 % of all exception events in the
// 2026-08-09 → 2026-08-19 window, 88 % of them a bare Chromium `net::ERR_*`
// (issue #1587). The decision lives here as a pure predicate rather than inline
// at the reporting site, same precedent as telemetry/expected-conditions.ts.
//
// Nothing is dropped: a demoted failure still ships as `app_log_recorded` at
// `warn`, with the same error code, redacted message and stack. Only the
// severity — and therefore the Error Tracking membership — moves.

import type { UpdaterErrorPhase } from './updater'

export type UpdaterErrorSeverity = 'warn' | 'error'

/**
 * Chromium transport codes that mean the device could not reach the network.
 * An allowlist, never a `net::ERR_` prefix test: a prefix match would also
 * swallow `net::ERR_CERT_*` / `net::ERR_SSL_*` (a certificate failure is a
 * security signal) and any future code we have not reasoned about.
 *
 * The second block was added from issue #1994's re-validation. Only builds that
 * already carry the #1587 classification (2026.822.1 and newer) can show an
 * allowlist gap — an older build reported every code as an error regardless, so
 * it carries no signal about this set. Cut that way, the check phase still
 * produced these four at error severity between 2026-08-22 and 2026-09-04.
 */
const TRANSIENT_NETWORK_ERRORS: ReadonlySet<string> = new Set([
  'net::ERR_NAME_NOT_RESOLVED',
  'net::ERR_INTERNET_DISCONNECTED',
  'net::ERR_NETWORK_CHANGED',
  'net::ERR_TIMED_OUT',
  'net::ERR_CONNECTION_TIMED_OUT',
  'net::ERR_CONNECTION_RESET',
  'net::ERR_CONNECTION_CLOSED',
  'net::ERR_CONNECTION_REFUSED',
  // The peer vanished before answering. Same class as the RESET/CLOSED pair
  // above, and the check never got a response to judge. 3 events / 1 user.
  'net::ERR_CONNECTION_ABORTED',
  // No route to the destination, or an address the stack refuses to route at
  // all — a downed interface or a captive portal handing back a bogus DNS
  // answer. Both are the device's own network, not our feed. 7 events / 3 users.
  'net::ERR_ADDRESS_UNREACHABLE',
  'net::ERR_ADDRESS_INVALID',
  // A local firewall or MDM policy blocked the socket before it left the
  // machine. Nothing the app did and nothing a user can act on. 1 event.
  'net::ERR_NETWORK_ACCESS_DENIED',
  // Laptop sleep: the network stack is suspended mid-request.
  'net::ERR_NETWORK_IO_SUSPENDED',
  'net::ERR_HTTP2_PROTOCOL_ERROR',
  'net::ERR_HTTP2_SERVER_REFUSED_STREAM'
])

/**
 * Only a background/manual *check* can be demoted. A transport failure during
 * `download` or `install` is materially worse than one during a poll — it can
 * leave a half-applied update — so it keeps error severity even when the code
 * is in the transient set. Deliberate narrowing, not an accident of the data:
 * 1,038 of the 1,043 noisy production events fired in the check phase.
 */
const CHECK_PHASES: ReadonlySet<UpdaterErrorPhase> = new Set<UpdaterErrorPhase>([
  'check',
  'startup-check',
  'scheduled-check',
  'auto-check-enable'
])

export const isUpdaterCheckPhase = (phase: UpdaterErrorPhase): boolean => CHECK_PHASES.has(phase)

const NET_ERROR_TOKEN = /net::ERR_[A-Z0-9_]+/g
const MAX_CAUSE_DEPTH = 4

const errorText = (value: unknown): string => {
  if (typeof value === 'string') return value
  if (!value || typeof value !== 'object') return ''
  const { message, code } = value as { message?: unknown; code?: unknown }
  return `${typeof message === 'string' ? message : ''} ${typeof code === 'string' ? code : ''}`
}

/**
 * Every `net::ERR_*` token in the error and its cause chain. electron-updater's
 * GitHubProvider wraps a transport failure in a parse-shaped message
 * (`ERR_UPDATER_INVALID_RELEASE_FEED`: "Cannot parse releases feed: … Error:
 * net::ERR_NETWORK_CHANGED"), so the outer code says nothing about the real
 * cause — 30 of 30 in production carried a network cause. Reading the whole
 * chain is what lets that code be demoted without demoting a feed that is
 * genuinely malformed.
 */
const collectNetErrorTokens = (error: unknown, depth = 0): string[] => {
  if (!error || depth > MAX_CAUSE_DEPTH) return []
  const text = errorText(error)
  const own = text ? [...text.matchAll(NET_ERROR_TOKEN)].map((match) => match[0]) : []
  const cause = typeof error === 'object' ? (error as { cause?: unknown }).cause : undefined
  return [...own, ...collectNetErrorTokens(cause, depth + 1)]
}

/**
 * `warn` only for a check that failed to reach the network. Fails closed:
 * anything with no recognised transport code, an unknown `net::ERR_*`, an HTTP
 * status (a 404 feed, a 618 `jwt:expired` asset URL), a signature failure or an
 * install-phase errno stays `error`.
 */
export const classifyUpdaterError = (
  error: unknown,
  phase: UpdaterErrorPhase
): UpdaterErrorSeverity => {
  if (!isUpdaterCheckPhase(phase)) return 'error'
  // A response arrived, so this is not a connectivity drop: the server said no.
  const status =
    error && typeof error === 'object' ? (error as { statusCode?: unknown }).statusCode : undefined
  if (typeof status === 'number') return 'error'
  const tokens = collectNetErrorTokens(error)
  if (tokens.length === 0) return 'error'
  return tokens.every((token) => TRANSIENT_NETWORK_ERRORS.has(token)) ? 'warn' : 'error'
}

/** GitHub's signed release-asset host. Every observed 618 came from here. */
const SIGNED_ASSET_HOST = 'release-assets.githubusercontent.com'

/**
 * A failure that is worth asking again for, because the thing that failed was a
 * token rather than the network.
 *
 * GitHub serves a release asset by redirecting to a short-lived signed
 * `release-assets.githubusercontent.com` URL. When the follow-up GET lands after
 * that token's expiry, GitHub answers with the non-standard status 618
 * (`jwt:expired`). That is 36 of 36 production `HTTP_ERROR_618` events — every
 * one in the check phase, on the channel file (`latest-mac.yml`) that
 * electron-updater's GitHubProvider fetches to learn the latest version.
 *
 * electron-updater never retries it. `HttpExecutor.doApiRequest` has no retry at
 * all on that path, and builder-util-runtime's `retryOnServerError` helper —
 * which nothing on this path calls — matches `>= 500 && <= 599`, so it would not
 * catch a 618 even if it were wired in. One expired token therefore loses the
 * whole update check.
 *
 * The token is minted fresh on each redirect, so asking again is the fix.
 */
export const isExpiredSignedAssetError = (error: unknown): boolean => {
  if (!error || typeof error !== 'object') return false
  const { statusCode } = error as { statusCode?: unknown }
  if (statusCode === 618) return true
  // A 403 is only read as an expired signature when the failing URL is the
  // signed-asset host: an unrelated 403 (API rate limit, private repo, proxy)
  // is a real refusal and must not be retried into a loop.
  if (statusCode !== 403) return false
  return errorText(error).includes(SIGNED_ASSET_HOST)
}

/**
 * A demoted failure must not make a genuinely stuck updater invisible. One
 * offline laptop is noise; an install that has not completed a single update
 * check in a day, while awake and retrying, can no longer receive a fix and is
 * worth an exception.
 *
 * Both conditions are required. Time alone would fire for a machine that slept
 * through the window and failed its first wake-up check; the failure count
 * alone would fire for an hour-long coffee-shop outage.
 */
const STUCK_CHECK_WINDOW_MS = 24 * 60 * 60 * 1000
const STUCK_CHECK_FAILURES = 6

interface UpdaterCheckHealth {
  /** Init time until the first successful check, so a never-succeeding install still ages. */
  lastSuccessAt: number
  consecutiveFailures: number
  stuckReported: boolean
}

let health: UpdaterCheckHealth = {
  lastSuccessAt: Date.now(),
  consecutiveFailures: 0,
  stuckReported: false
}

/** Start the stuck-updater clock. Called from initializeUpdater(). */
export const resetUpdaterCheckHealth = (now = Date.now()): void => {
  health = { lastSuccessAt: now, consecutiveFailures: 0, stuckReported: false }
}

/** A check that reached the feed — update available or not — clears the streak. */
export const recordUpdaterCheckSuccess = (now = Date.now()): void => {
  health = { lastSuccessAt: now, consecutiveFailures: 0, stuckReported: false }
}

/**
 * Count a failed check. `stuck` is true exactly once per streak (latched until
 * the next success) so the escalation is one exception, not a second flood.
 */
export const recordUpdaterCheckFailure = (
  now = Date.now()
): { consecutiveFailures: number; stuck: boolean } => {
  health.consecutiveFailures += 1
  const stuck =
    !health.stuckReported &&
    health.consecutiveFailures >= STUCK_CHECK_FAILURES &&
    now - health.lastSuccessAt >= STUCK_CHECK_WINDOW_MS
  if (stuck) health.stuckReported = true
  return { consecutiveFailures: health.consecutiveFailures, stuck }
}
