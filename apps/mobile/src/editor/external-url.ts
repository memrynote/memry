/**
 * Web and mail only. The same set desktop applies before `shell.openExternal`
 * (`apps/desktop/src/main/lib/external-url.ts`), for the same reason: the URL
 * arrives from note content, so anything wider lets a synced note launch an
 * arbitrary protocol handler on the reader's phone.
 */
const ALLOWED_SCHEMES = new Set(['https:', 'http:', 'mailto:'])

/** Whether a URL from a note is safe to hand to `Linking.openURL`. */
export function isAllowedExternalUrl(rawUrl: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(rawUrl).protocol)
  } catch {
    return false
  }
}
