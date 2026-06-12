const EXTERNAL_URL_ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/**
 * Whether a URL is safe to hand to `shell.openExternal`. Only web/mail schemes
 * are allowed so renderer-triggered `window.open` cannot launch arbitrary
 * protocols (file:, smb:, custom handlers) via the OS.
 */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return EXTERNAL_URL_ALLOWED_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}
