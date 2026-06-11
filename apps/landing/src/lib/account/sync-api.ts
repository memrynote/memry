import type { AuthStorage } from './auth-storage'

interface SyncApiOptions {
  baseUrl: string
  storage: AuthStorage
  fetchImpl?: typeof fetch
}

export function createSyncApi({ baseUrl, storage, fetchImpl = fetch }: SyncApiOptions) {
  async function refresh(): Promise<boolean> {
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
        storage.clearSession()
      }
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
