import { FALLBACK_LOCALE, LocaleSchema, type Locale } from '@memry/contracts/locale-api'

/**
 * The locale to build the i18n instance with, available before the first `await`. Rust
 * publishes it in `window.__MEMRY_STARTUP__`; a renderer running without that (unit tests, a
 * page opened outside the app window) gets the fallback, and the post-render reconcile
 * corrects it.
 */
export function getStartupLocale(): Locale {
  const result = LocaleSchema.safeParse(window.__MEMRY_STARTUP__?.locale)
  return result.success ? result.data : FALLBACK_LOCALE
}
