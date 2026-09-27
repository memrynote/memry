import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useGeneralSettings } from './use-general-settings'
import { setDateFormatPref } from '@/lib/format-date'
import { FONT_FAMILY_MAP, sanitizeFontFamilyName } from '@/lib/interface-font'
import { createLogger } from '@/lib/logger'
import { resolveFontSizePx } from '@memry/contracts/font-size'
import { clampZoomFactor } from '@memry/contracts/app-zoom'
import {
  applyColorTheme,
  COLOR_THEME_STORAGE_KEY,
  type ThemeCustomization
} from '@memry/contracts/color-themes'

const log = createLogger('ThemeSync')

export interface ThemeSyncState {
  /** For the app's MotionConfig, which CSS alone cannot reach. */
  reduceMotion: 'system' | 'on'
}

export function useThemeSync(): ThemeSyncState {
  const { settings, isLoading } = useGeneralSettings()
  const { setTheme } = useTheme()

  useEffect(() => {
    if (isLoading) return
    log.debug('Syncing theme:', settings.theme)
    setTheme(settings.theme)
  }, [isLoading, settings.theme, setTheme])

  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.setProperty('--user-accent-color', settings.accentColor)
  }, [isLoading, settings.accentColor])

  const {
    colorTheme,
    accentColor,
    useThemeAccent,
    backgroundLight,
    foregroundLight,
    backgroundDark,
    foregroundDark
  } = settings
  useEffect(() => {
    if (isLoading) return
    const custom: ThemeCustomization = {
      colorTheme,
      accentColor,
      useThemeAccent,
      backgroundLight,
      foregroundLight,
      backgroundDark,
      foregroundDark
    }
    applyColorTheme(document.documentElement, custom)
    // Cached for the preload, which paints it before the next launch's first frame.
    try {
      window.localStorage.setItem(COLOR_THEME_STORAGE_KEY, JSON.stringify(custom))
    } catch {
      // Losing the cache only costs the next launch a flash of the built-in palette
    }
  }, [
    isLoading,
    colorTheme,
    accentColor,
    useThemeAccent,
    backgroundLight,
    foregroundLight,
    backgroundDark,
    foregroundDark
  ])

  useEffect(() => {
    if (isLoading) return
    const root = document.documentElement
    root.toggleAttribute('data-pointer-cursors', settings.pointerCursors === true)
    root.toggleAttribute('data-font-smoothing', settings.fontSmoothing === true)
    if (settings.reduceMotion === 'on') root.setAttribute('data-reduce-motion', 'on')
    else root.removeAttribute('data-reduce-motion')
  }, [isLoading, settings.pointerCursors, settings.fontSmoothing, settings.reduceMotion])

  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.fontSize = `${resolveFontSizePx(settings.fontSizePx, settings.fontSize)}px`
  }, [isLoading, settings.fontSizePx, settings.fontSize])

  useEffect(() => {
    if (isLoading) return
    window.api.setZoomFactor(clampZoomFactor(settings.zoomFactor))
  }, [isLoading, settings.zoomFactor])

  useEffect(() => {
    if (isLoading) return
    const chosen = FONT_FAMILY_MAP[settings.fontFamily]
    // A custom font is a preference in front of the chosen family, not instead
    // of it: it goes first in the stack, so a name this machine does not have
    // installed falls through to the chosen family (or the system stack) with
    // nothing to detect. Sanitizing also keeps the value from escaping the
    // declaration it is interpolated into.
    const custom = sanitizeFontFamilyName(settings.customFontFamily ?? '')
    const family = custom ? `'${custom}', ${chosen || FONT_FAMILY_MAP['sans-serif']}` : chosen

    if (family) {
      document.documentElement.style.setProperty('--font-sans', family)
    } else {
      document.documentElement.style.removeProperty('--font-sans')
    }
  }, [isLoading, settings.fontFamily, settings.customFontFamily])

  // Keep format-date's module cache in sync so pure (non-React) date helpers
  // format with the user's chosen format.
  useEffect(() => {
    if (isLoading) return
    setDateFormatPref(settings.dateFormat)
  }, [isLoading, settings.dateFormat])

  return { reduceMotion: settings.reduceMotion === 'on' ? 'on' : 'system' }
}
