import { ipcRenderer } from 'electron'
import { LocaleChannels } from '@memry/contracts/ipc-channels'
import { LocaleSchema, FALLBACK_LOCALE, type Locale } from '@memry/contracts/locale-api'
import { localeDirection } from '@memry/i18n/shared/direction'

export const LOCALE_STORAGE_KEY = 'memry-locale'

function parseLocale(value: unknown): Locale | null {
  const result = LocaleSchema.safeParse(value)
  return result.success ? result.data : null
}

export function cacheStartupLocale(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale)
  } catch {
    // localStorage may be unavailable in some test or restricted environments
  }
}

/**
 * The locale to boot with, with no await anywhere on the path.
 *
 * The renderer used to open with `await window.api.locale.get()`, so the i18n
 * bundle load could not even start until an IPC round-trip came back — and that
 * round-trip races vault open on the main process. The cache makes the common
 * launch free; `sendSync` covers the launch that has no cache yet (first run,
 * first launch after upgrading to this build, cleared storage) and is
 * authoritative, so a missing cache can never produce a wrong-language frame.
 */
export function getStartupLocaleSync(): Locale {
  try {
    const cached = parseLocale(window.localStorage.getItem(LOCALE_STORAGE_KEY))
    if (cached) return cached
  } catch {
    // localStorage may be unavailable; fall through to IPC
  }

  try {
    const locale = parseLocale(ipcRenderer.sendSync(LocaleChannels.GetStartupSync))
    if (locale) {
      cacheStartupLocale(locale)
      return locale
    }
  } catch {
    // fall through
  }

  return FALLBACK_LOCALE
}

/**
 * Re-reads the authoritative locale and rewrites the cache. Fire-and-forget and
 * off the boot path — nothing waits on it. Without this a cache that somehow
 * went stale would stay stale, and the renderer would correct the same
 * mismatch on every launch forever instead of once.
 */
export function refreshStartupLocaleCache(): void {
  void ipcRenderer
    .invoke(LocaleChannels.Get)
    .then((value: unknown) => {
      const locale = parseLocale(value)
      if (locale) cacheStartupLocale(locale)
    })
    .catch(() => {
      // A locale we cannot re-read is a locale we leave cached as-is
    })
}

/**
 * Sets `<html lang>` and `<html dir>` before any renderer script evaluates, so
 * an RTL user's document is never LTR while the entry chunk is still parsing.
 * Mirrors applyStartupTheme's DOMContentLoaded guard: the preload can run
 * before documentElement exists.
 */
export function applyStartupLocale(locale: Locale): void {
  const direction = localeDirection(locale)

  const applyToRoot = (): boolean => {
    const root = document.documentElement
    if (!root) return false

    root.setAttribute('lang', locale)
    root.setAttribute('dir', direction)
    return true
  }

  if (!applyToRoot()) {
    window.addEventListener(
      'DOMContentLoaded',
      () => {
        applyToRoot()
      },
      { once: true }
    )
  }
}
