type LocaleWithTextInfo = Intl.Locale & {
  textInfo?: {
    direction: 'ltr' | 'rtl'
  }
  getTextInfo?: () => {
    direction: 'ltr' | 'rtl'
  }
}

/**
 * Returns the writing direction for a locale using `Intl.Locale`.
 * V8 15 (Electron 43 / Chromium 150) removed the legacy `textInfo` getter in
 * favor of the standardized `getTextInfo()` method; older runtimes only have
 * the getter. Feature-detect the method first, fall back to the getter.
 * No fallback table - the platform owns the locale-direction mapping.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  const intlLocale = new Intl.Locale(locale) as LocaleWithTextInfo
  const textInfo =
    typeof intlLocale.getTextInfo === 'function' ? intlLocale.getTextInfo() : intlLocale.textInfo
  return textInfo?.direction ?? 'ltr'
}
