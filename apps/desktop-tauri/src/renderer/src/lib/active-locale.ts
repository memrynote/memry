import { FALLBACK_LOCALE, type Locale } from '@memry/i18n/shared'

// Module-scoped active locale so pure (non-React) formatting helpers can reach
// Intl with the language the user actually picked, without threading a param
// through every call site. Mirrors the `setDateFormatPref` pattern in
// `format-date.ts`. Kept in sync from `main.tsx`, which subscribes to i18next's
// `languageChanged`, so every `changeLanguage` call site updates it.
let current: Locale = FALLBACK_LOCALE

export function setActiveLocale(locale: Locale): void {
  current = locale
}

/**
 * BCP 47 tag for Intl / toLocale*String calls in user-visible formatting.
 * Never pass `undefined` (that follows the OS locale, not the app's) and never
 * hardcode `'en-US'` (that ignores the user's choice entirely).
 */
export function getActiveLocale(): Locale {
  return current
}
