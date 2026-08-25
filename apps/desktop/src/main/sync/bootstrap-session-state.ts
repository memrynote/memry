/**
 * Bootstrap session state (#1837) — the smallest possible module so both the
 * HTTP layer and the sync engine can read it without import cycles.
 *
 * The bootstrap-session MANAGER (bootstrap-session.ts) writes here; every
 * authenticated request reads the token for header injection and every pacing
 * site reads the elevation factor. A closed/expired/failed session leaves this
 * module empty, which is exactly "today's behavior".
 */

/** Header name per @memry/contracts/bootstrap-api; duplicated as a literal so
 * this module stays dependency-free for the http-client hot path. */
const TOKEN_HEADER = 'X-Memry-Bootstrap-Token'

interface ActiveBootstrapSession {
  token: string
  /** Epoch ms after which the token is no longer honored server-side. */
  expiresAtMs: number
  /**
   * Granted ceiling multiplier. Mirrors the server's
   * BOOTSTRAP_ELEVATION_MULTIPLIERS; pacing sites divide their steady-state
   * slices by it.
   */
  elevationFactor: number
}

let active: ActiveBootstrapSession | null = null

export const setBootstrapSessionState = (
  token: string,
  expiresAtMs: number,
  elevationFactor: number
): void => {
  active = { token, expiresAtMs, elevationFactor }
}

export const clearBootstrapSessionState = (): void => {
  active = null
}

/**
 * Headers to attach to an authenticated sync request. Empty when no bootstrap
 * session is live — old servers ignore unknown headers either way, and a
 * locally-expired session stops injecting immediately even before the manager
 * notices.
 */
export const getBootstrapTokenHeaders = (): Record<string, string> => {
  if (!active) return {}
  if (Date.now() >= active.expiresAtMs) return {}
  return { [TOKEN_HEADER]: active.token }
}

/**
 * The factor pacing sites divide their delays by. 1 = steady-state pacing;
 * also collapses to 1 the instant the session is gone or past its expiry.
 */
export const getBootstrapElevationFactor = (): number => {
  if (!active) return 1
  if (Date.now() >= active.expiresAtMs) return 1
  return Number.isFinite(active.elevationFactor) && active.elevationFactor >= 1
    ? active.elevationFactor
    : 1
}
