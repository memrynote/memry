import type { Locale } from '../shared/config'
import { loadLocaleResources, type LocaleResources } from '../locales/load'

/**
 * Returns the full set of namespaces for a locale.
 */
export function loadResources(locale: Locale): Promise<LocaleResources> {
  return loadLocaleResources(locale)
}
