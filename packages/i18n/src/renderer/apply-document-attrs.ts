import { localeDirection } from '../shared/direction'
import type { Locale } from '../shared/config'

/**
 * Sets <html lang> and <html dir> from the active locale.
 */
export function applyLocaleToDocument(locale: Locale): void {
  const html = document.documentElement
  html.setAttribute('lang', locale)
  html.setAttribute('dir', localeDirection(locale))
}
