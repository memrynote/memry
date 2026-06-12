const fallback = 'http://localhost:8787'

export const SYNC_SERVER_URL: string =
  (import.meta.env.VITE_SYNC_SERVER_URL as string | undefined)?.replace(/\/$/, '') ?? fallback

export const WEB_OAUTH_REDIRECT_PATH = '/auth/oauth/callback'
