/**
 * The interface font a user picks in Settings → Appearance: either one of the
 * bundled presets or a family installed on this machine.
 *
 * The chosen name is interpolated straight into a CSS font stack, so it is
 * sanitized rather than validated against the enumerated list: a family that
 * `queryLocalFonts()` never reported — typed into an older build, or
 * uninstalled since — needs no handling at all, it loses the stack race and the
 * next entry renders instead.
 */

const MAX_FONT_NAME_LENGTH = 64

// Letters, digits, spaces and the three separators real font names use. Quotes,
// commas, semicolons and braces are dropped so the value cannot escape the
// `font-family` declaration it is interpolated into.
const DISALLOWED_CHARS = /[^\p{L}\p{N} \-_.]/gu

export function sanitizeFontFamilyName(raw: string): string {
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
  const family = sanitizeFontFamilyName(name)
  if (!family) return false

  try {
    if (typeof document.fonts?.check !== 'function') return true
    return document.fonts.check(`16px "${family}"`)
  } catch {
    return true
  }
}

export const BUILT_IN_FONT_FAMILIES = [
  'system',
  'sans-serif',
  'serif',
  'gelasio',
  'geist',
  'inter',
  'monospace'
] as const

export type BuiltInFontFamily = (typeof BUILT_IN_FONT_FAMILIES)[number]

/** CSS stack per preset, shared by the theme sync and the picker's previews. */
export const FONT_FAMILY_MAP: Record<BuiltInFontFamily, string> = {
  system: '',
  serif: "'Crimson Pro Variable', Georgia, 'Times New Roman', serif",
  'sans-serif':
    'ui-sans-serif, -apple-system, "system-ui", "Segoe UI Variable Display", "Segoe UI", Helvetica, "Apple Color Emoji", "Noto Sans Arabic", "Noto Sans Hebrew", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"',
  monospace: "'JetBrains Mono Variable', 'Fira Code', 'Cascadia Code', monospace",
  gelasio: "'Gelasio', Georgia, 'Times New Roman', serif",
  geist: "'Geist Variable', ui-sans-serif, -apple-system, system-ui, sans-serif",
  inter: "'Inter Variable', ui-sans-serif, -apple-system, system-ui, sans-serif"
}

export type FontChoice =
  { kind: 'builtin'; family: BuiltInFontFamily } | { kind: 'system'; family: string }

function isBuiltInFontFamily(value: string): value is BuiltInFontFamily {
  return (BUILT_IN_FONT_FAMILIES as readonly string[]).includes(value)
}

// The kind prefix keeps a system family literally named "inter" from colliding
// with the built-in preset of the same id.
export function fontChoiceKey(choice: FontChoice): string {
  return `${choice.kind}:${choice.family}`
}

export function parseFontChoiceKey(key: string): FontChoice | null {
  if (key.startsWith('builtin:')) {
    const family = key.slice('builtin:'.length)
    return isBuiltInFontFamily(family) ? { kind: 'builtin', family } : null
  }
  if (key.startsWith('system:')) {
    const family = sanitizeFontFamilyName(key.slice('system:'.length))
    return family ? { kind: 'system', family } : null
  }
  return null
}

/** The one selection the picker shows, read out of the two persisted fields. */
export function fontChoiceFromSettings(
  fontFamily: string,
  customFontFamily: string | undefined
): FontChoice {
  const custom = sanitizeFontFamilyName(customFontFamily ?? '')
  if (custom) return { kind: 'system', family: custom }
  return { kind: 'builtin', family: isBuiltInFontFamily(fontFamily) ? fontFamily : 'system' }
}

export function fontChoiceToSettings(choice: FontChoice): {
  fontFamily?: BuiltInFontFamily
  customFontFamily: string
} {
  if (choice.kind === 'builtin') return { fontFamily: choice.family, customFontFamily: '' }
  // `fontFamily` is deliberately left untouched: an install that already pairs a
  // preset with a custom family keeps rendering exactly as it did, because
  // use-theme-sync puts the custom family in front of the preset in the stack.
  return { customFontFamily: choice.family }
}

export { MAX_FONT_NAME_LENGTH }
