// Carries the post-login destination across the Google OAuth round-trip (the
// redirect leaves the SPA, so query state is lost — sessionStorage survives it).
export const OAUTH_NEXT_STORAGE_KEY = 'memry:auth:next'

// Post-login redirect target. Open-redirect guard: only same-origin relative
// paths are allowed. Rejects absolute URLs and protocol-relative `//host` (and
// the `/\host` variant some browsers normalize to protocol-relative).
export function safeNextPath(
  next: string | null | undefined,
  fallback = '/account/profile'
): string {
  if (!next || !next.startsWith('/')) return fallback
  if (next[1] === '/' || next[1] === '\\') return fallback
  return next
}
