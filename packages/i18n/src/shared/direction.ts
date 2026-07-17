type LocaleWithTextInfo = {
  textInfo?: {
    direction: 'ltr' | 'rtl'
  }
  getTextInfo?: () => {
    direction: 'ltr' | 'rtl'
  }
}

/**
 * Resolves the writing direction from a locale-like object.
 * V8 15 (Electron 43 / Chromium 150) removed the legacy `textInfo` getter in
 * favor of the standardized `getTextInfo()` method; older runtimes only have
 * the getter. Feature-detect the method first, fall back to the getter.
 * No fallback table - the platform owns the locale-direction mapping.
 */
export function resolveLocaleDirection(loc: LocaleWithTextInfo): 'ltr' | 'rtl' {
  const textInfo = typeof loc.getTextInfo === 'function' ? loc.getTextInfo() : loc.textInfo
  return textInfo?.direction ?? 'ltr'
}

/**
 * Returns the writing direction for a locale using `Intl.Locale`.
 * A structurally invalid locale string makes `new Intl.Locale` throw; at boot
 * that would white-window the window, so an invalid locale falls back to 'ltr'.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  try {
    return resolveLocaleDirection(new Intl.Locale(locale) as LocaleWithTextInfo)
  } catch {
    return 'ltr'
  }
}
