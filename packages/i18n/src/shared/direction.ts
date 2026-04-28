type LocaleWithTextInfo = Intl.Locale & {
  textInfo: {
    direction: 'ltr' | 'rtl'
  }
}

/**
 * Returns the writing direction for a locale using `Intl.Locale.textInfo`.
 * Built into Electron 39 (Chromium 119+ / V8 12.0). No fallback table -
 * the platform owns the locale-direction mapping.
 */
export function localeDirection(locale: string): 'ltr' | 'rtl' {
  return (new Intl.Locale(locale) as LocaleWithTextInfo).textInfo.direction
}
