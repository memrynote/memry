import { FALLBACK_LOCALE, LocaleSchema, type Locale } from '@memry/contracts/locale-api'

/**
 * The locale to build the i18n instance with, available before the first
 * `await`. The preload resolves it from its cache or synchronous IPC; a
 * renderer running without that bridge (unit tests, a stale preload) gets the
 * fallback and the post-render reconcile corrects it.
 */
export function getStartupLocale(): Locale {
  const result = LocaleSchema.safeParse(window.api?.locale?.getStartupSync?.())
  return result.success ? result.data : FALLBACK_LOCALE
}
