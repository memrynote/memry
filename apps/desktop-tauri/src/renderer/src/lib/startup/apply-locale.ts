import { type Locale } from '@memry/contracts/locale-api'
import { localeDirection } from '@memry/i18n/shared/direction'
import { getStartupLocale } from '../startup-locale'

export const LOCALE_STORAGE_KEY = 'memry-locale'

export function cacheStartupLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage may be unavailable in restricted environments
  }
}

/**
 * Sets `<html lang>` and `<html dir>` before the entry chunk parses, so an RTL user's document
 * is never LTR in between, and refreshes the locale cache.
 */
export function applyStartupLocale(): void {
  const locale = getStartupLocale()
  cacheStartupLocale(locale)
  const direction = localeDirection(locale)

  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false
    root.setAttribute('lang', locale)
    root.setAttribute('dir', direction)
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener('DOMContentLoaded', () => void applyToRoot(), { once: true })
  }
}
