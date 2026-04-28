import { z } from 'zod'

export const LocaleSchema = z.enum(['en', 'tr', 'ar'])
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
}
