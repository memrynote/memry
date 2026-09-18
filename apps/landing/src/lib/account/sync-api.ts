import type { AuthStorage } from './auth-storage'

interface SyncApiOptions {
  baseUrl: string
  storage: AuthStorage
  fetchImpl?: typeof fetch
  // Fired when the session is dropped mid-request so the auth context can flip
  // isSignedIn and the route guards can bounce to /login. Without it the UI
  // keeps rendering a signed-in shell over a dead session.
  onSessionCleared?: () => void
}

export function createSyncApi({
  baseUrl,
  storage,
  fetchImpl = fetch,
  onSessionCleared
}: SyncApiOptions) {
  // The refresh token is single-use. If several authed calls 401 at once they
  // must share one in-flight /auth/refresh instead of each spending the same
  // token and clobbering the rotated session (which would force a spurious
  // sign-out).
  let inFlightRefresh: Promise<boolean> | null = null

  function refresh(): Promise<boolean> {
    if (inFlightRefresh) return inFlightRefresh
    const run = async (): Promise<boolean> => {
      const session = storage.getSession()
      if (!session) return false
      const res = await fetchImpl(`${baseUrl}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: session.refreshToken })
      })
      if (!res.ok) return false
      const data = (await res.json()) as { accessToken: string; refreshToken: string }
      storage.setSession({ ...session, ...data })
      return true
    }
    inFlightRefresh = run().finally(() => {
      inFlightRefresh = null
    })
    return inFlightRefresh
  }

  function dropSession(): void {
    storage.clearSession()
    onSessionCleared?.()
  }

  async function isDeviceRevoked(res: Response): Promise<boolean> {
    const body = await res
      .clone()
      .text()
      .catch(() => '')
    return body.includes('AUTH_DEVICE_REVOKED')
  }

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const send = () => {
      const token = storage.getSession()?.accessToken
      return fetchImpl(`${baseUrl}${path}`, {
        ...init,
        headers: {
          'Content-Type': 'application/json',
          ...(init.headers ?? {}),
          ...(token ? { Authorization: `Bearer ${token}` } : {})
        }
      })
    }
    let res = await send()
    if (res.status === 401) {
      if (await refresh()) {
        res = await send()
      } else {
        // Refresh token is gone/expired — drop the local session so the route
        // guard sends the user back to /auth instead of looping on failed calls.
        dropSession()
      }
    }
    // A revoked device answers 403, not 401, so refreshing cannot help: the
    // tokens are valid and every authed call stays dead. Drop the session and
    // let the user sign in again instead of retrying forever.
    if (res.status === 403 && (await isDeviceRevoked(res))) {
      dropSession()
    }
    return res
  }

  async function authedJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await authedFetch(path, init)
    if (!res.ok) {
      const message = await res.text().catch(() => '')
      throw new Error(message || `Request failed: ${res.status}`)
    }
    return (await res.json()) as T
  }

  // Public (unauthenticated) helper for OTP/OAuth/device endpoints.
  async function publicJson<T = unknown>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${baseUrl}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) }
    })
    if (!res.ok) {
      const message = await res.text().catch(() => '')
      throw new Error(message || `Request failed: ${res.status}`)
    }
    return (await res.json()) as T
  }

  return { authedFetch, authedJson, publicJson }
}

export type SyncApi = ReturnType<typeof createSyncApi>
