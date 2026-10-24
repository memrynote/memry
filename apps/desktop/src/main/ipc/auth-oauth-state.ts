import type http from 'node:http'

// OAuth state & loopback server handle (T072, T072a). Lives apart from the
// handlers so session teardown can clear it without importing them.

interface OAuthSession {
  state: string
  redirectUri: string
  createdAt: number
}

export const oauthSessions = new Map<string, OAuthSession>()
export const OAUTH_SESSION_TIMEOUT_MS = 10 * 60 * 1000
let activeLoopbackServer: http.Server | null = null

export const cleanExpiredOAuthSessions = (): void => {
  const now = Date.now()
  for (const [state, session] of oauthSessions) {
    if (now - session.createdAt > OAUTH_SESSION_TIMEOUT_MS) {
      oauthSessions.delete(state)
    }
  }
}

export const consumeOAuthSession = (state: string): OAuthSession => {
  const session = oauthSessions.get(state)
  if (!session) {
    throw new Error('Invalid or expired OAuth state parameter')
  }
  if (Date.now() - session.createdAt > OAUTH_SESSION_TIMEOUT_MS) {
    oauthSessions.delete(state)
    throw new Error('OAuth session expired. Please try again.')
  }
  oauthSessions.delete(state)
  return session
}

export const shutdownLoopbackServer = (): void => {
  if (activeLoopbackServer) {
    activeLoopbackServer.close()
    activeLoopbackServer = null
  }
}

export const setActiveLoopbackServer = (server: http.Server): void => {
  activeLoopbackServer = server
}

// Test seam — let tests inject an OAuth state without hitting Google
export function seedOAuthSession(state: string, redirectUri: string): void {
  oauthSessions.set(state, { state, redirectUri, createdAt: Date.now() })
}

// State cleanup (composed by clearInMemoryAuthState)
export function clearOAuthState(): void {
  oauthSessions.clear()
  shutdownLoopbackServer()
}
