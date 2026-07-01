const PROD_SYNC_SERVER_URL = 'https://sync.memrynote.com'
const DEV_SYNC_SERVER_URL = 'http://localhost:8787'

// Resolve the sync-server base URL. An explicit VITE_SYNC_SERVER_URL always wins
// (e.g. staging). Otherwise default by build mode so a forgotten env var in the
// production deploy never silently falls back to localhost.
export function resolveSyncServerUrl(override: string | undefined, isProd: boolean): string {
  const trimmed = override?.trim().replace(/\/$/, '')
  if (trimmed) return trimmed
  return isProd ? PROD_SYNC_SERVER_URL : DEV_SYNC_SERVER_URL
}

export const SYNC_SERVER_URL: string = resolveSyncServerUrl(
  import.meta.env?.VITE_SYNC_SERVER_URL as string | undefined,
  Boolean(import.meta.env?.PROD)
)

export const WEB_OAUTH_REDIRECT_PATH = '/auth/oauth/callback'
