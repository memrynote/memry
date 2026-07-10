import { SyncServerError } from './http-client'

export interface AuthRetryDeps {
  refreshAccessToken: () => Promise<boolean>
  getAccessToken: () => Promise<string | null>
}

/**
 * Runs a token-bearing sync request; on 401 refreshes the session and retries
 * exactly once with the fresh token. Proactive refresh can't cover a token
 * expiring between resolution and the request landing (long sync cycles,
 * sleep/wake), so the server 401 itself is the refresh signal. If the refresh
 * or the retry fails, the original 401 (or the retry's error) propagates —
 * token-manager owns session-expired emission on terminal refresh failure.
 */
/** Adapts SyncEngineDeps (where refreshAccessToken is optional) to AuthRetryDeps. */
export function engineAuthRetryDeps(deps: {
  getAccessToken: () => Promise<string | null>
  refreshAccessToken?: () => Promise<boolean>
}): AuthRetryDeps {
  return {
    // No refresh fn wired → treat the session as unrefreshable so a 401 rethrows.
    refreshAccessToken: () => deps.refreshAccessToken?.() ?? Promise.resolve(false),
    getAccessToken: deps.getAccessToken
  }
}

export async function withAuthRetry<T>(
  fn: (token: string) => Promise<T>,
  token: string,
  deps: AuthRetryDeps,
  onNewToken?: (token: string) => void
): Promise<T> {
  try {
    return await fn(token)
  } catch (err) {
    if (!(err instanceof SyncServerError) || err.statusCode !== 401) throw err

    const refreshed = await deps.refreshAccessToken()
    if (!refreshed) throw err

    const freshToken = await deps.getAccessToken()
    if (!freshToken) throw err

    onNewToken?.(freshToken)
    return fn(freshToken)
  }
}
