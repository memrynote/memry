/**
 * The custom interface font a user types in Settings → Appearance.
 *
 * The name goes straight into a CSS font stack, so it is sanitized rather than
 * validated against a list: the app has no way to enumerate the fonts a machine
 * has installed, and a name that is not installed needs no handling at all —
 * it loses the stack race and the next entry (the chosen font family, or the
 * system default) renders instead.
 */

const MAX_FONT_NAME_LENGTH = 64

// Letters, digits, spaces and the three separators real font names use. Quotes,
// commas, semicolons and braces are dropped so the value cannot escape the
// `font-family` declaration it is interpolated into.
const DISALLOWED_CHARS = /[^\p{L}\p{N} \-_.]/gu

export function sanitizeCustomFontName(raw: string): string {
  return raw
    .replace(DISALLOWED_CHARS, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_FONT_NAME_LENGTH)
}

/**
 * Whether this machine can render the given family. Used only to warn in
 * Settings — the fallback works either way, so an environment without a usable
 * `document.fonts.check` (jsdom) reports "installed" rather than crying wolf.
 */
export function isFontInstalled(name: string): boolean {
  const family = sanitizeCustomFontName(name)
  if (!family) return false

  try {
    if (typeof document.fonts?.check !== 'function') return true
    return document.fonts.check(`16px "${family}"`)
  } catch {
    return true
  }
}

export { MAX_FONT_NAME_LENGTH }
