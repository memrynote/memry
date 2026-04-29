import type { Locale } from '../shared/config'
import { RESOURCES } from '../locales'

/**
 * Returns the full set of namespaces for a locale, loaded eagerly via the
 * static RESOURCES map. Used by the main-process i18next instance, which
 * must initialize synchronously before the native menu is built.
 */
export function loadResources(locale: Locale): (typeof RESOURCES)[Locale] {
  return RESOURCES[locale]
}
