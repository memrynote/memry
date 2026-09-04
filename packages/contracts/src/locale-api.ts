import { z } from 'zod'

export const LocaleSchema = z.enum([
  'ar',
  'cs',
  'da',
  'en',
  'de',
  'el',
  'es',
  'fi',
  'fil',
  'fr',
  'he',
  'hr',
  'hu',
  'id',
  'it',
  'ja',
  'ko',
  'ms',
  'nl',
  'no',
  'pl',
  'pt',
  'ro',
  'ru',
  'sk',
  'sv',
  'th',
  'tr',
  'uk',
  'vi',
  'zh-CN',
  'zh-TW'
])
export type Locale = z.infer<typeof LocaleSchema>

export const SUPPORTED_LOCALES = LocaleSchema.options
export const FALLBACK_LOCALE: Locale = 'en'

/**
 * Renderer-side IPC bridge for runtime locale control. Distinct from the
 * existing settings IPC: `LocaleApi.set` atomically persists the
 * `GeneralSettings.language` field AND triggers a runtime change
 * (instance.changeLanguage + native menu rebuild + broadcast).
 */
export interface LocaleApi {
  get: () => Promise<Locale>
  set: (locale: Locale) => Promise<void>
  list: () => Promise<readonly Locale[]>
  /**
   * The locale to boot with, resolved without awaiting anything. Reads the
   * preload's localStorage cache first and only falls back to synchronous IPC
   * when there is no usable cached value. `get()` stays the authority.
   */
  getStartupSync: () => Locale
}
