import { useEffect, useState } from 'react'
import { useTheme } from 'next-themes'
import type { CustomTheme } from '@memry/contracts/themes-api'
import { useGeneralSettings } from './use-general-settings'
import { setDateFormatPref } from '@/lib/format-date'
import { createLogger } from '@/lib/logger'
import { themesService, onThemeUpdated, onThemeDeleted } from '@/services/themes-service'
import {
  applyCustomThemeVariables,
  clearCustomThemeVariables,
  clearCachedThemeOverrides,
  writeCachedThemeOverrides
} from '@/lib/theme-overrides'

const log = createLogger('ThemeSync')

const FONT_SIZE_MAP = {
  small: '14px',
  medium: '16px',
  large: '20px'
} as const

const FONT_FAMILY_MAP: Record<string, string> = {
  system: '',
  serif: "'Crimson Pro Variable', Georgia, 'Times New Roman', serif",
  'sans-serif':
    'ui-sans-serif, -apple-system, "system-ui", "Segoe UI Variable Display", "Segoe UI", Helvetica, "Apple Color Emoji", "Noto Sans Arabic", "Noto Sans Hebrew", Arial, sans-serif, "Segoe UI Emoji", "Segoe UI Symbol"',
  monospace: "'JetBrains Mono Variable', 'Fira Code', 'Cascadia Code', monospace",
  gelasio: "'Gelasio', Georgia, 'Times New Roman', serif",
  geist: "'Geist Variable', ui-sans-serif, -apple-system, system-ui, sans-serif",
  inter: "'Inter Variable', ui-sans-serif, -apple-system, system-ui, sans-serif"
}

export function useThemeSync(): void {
  const { settings, isLoading } = useGeneralSettings()
  const { setTheme } = useTheme()
  const [customTheme, setCustomTheme] = useState<CustomTheme | null>(null)

  useEffect(() => {
    if (isLoading) return
    log.debug('Syncing theme:', settings.theme)
    setTheme(settings.theme)
  }, [isLoading, settings.theme, setTheme])

  // Resolve the active custom theme (if any) and follow its remote/local edits.
  useEffect(() => {
    if (isLoading) return
    const customThemeId = settings.customThemeId
    if (!customThemeId) {
      setCustomTheme(null)
      return
    }

    let alive = true
    const load = (): void => {
      themesService
        .list()
        .then((themes) => {
          if (!alive) return
          setCustomTheme(themes.find((theme) => theme.id === customThemeId) ?? null)
        })
        .catch((err) => log.warn('Failed to load custom theme', err))
    }
    load()

    const unsubscribeUpdated = onThemeUpdated((event) => {
      if (event.id === customThemeId) load()
    })
    const unsubscribeDeleted = onThemeDeleted((event) => {
      if (event.id === customThemeId) setCustomTheme(null)
    })
    return () => {
      alive = false
      unsubscribeUpdated()
      unsubscribeDeleted()
    }
  }, [isLoading, settings.customThemeId])

  // Apply/clear the custom theme's variable overrides and keep the startup
  // FOUC cache in sync.
  useEffect(() => {
    if (isLoading) return
    const root = document.documentElement
    if (customTheme) {
      applyCustomThemeVariables(root, customTheme.variables)
      writeCachedThemeOverrides(customTheme.variables)
    } else {
      clearCustomThemeVariables(root)
      clearCachedThemeOverrides()
    }
  }, [isLoading, customTheme])

  useEffect(() => {
    if (isLoading) return
    // A custom theme's own accent wins over the global accent setting.
    const themeAccent = customTheme?.variables['--user-accent-color']
    document.documentElement.style.setProperty(
      '--user-accent-color',
      themeAccent ?? settings.accentColor
    )
  }, [isLoading, settings.accentColor, customTheme])

  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.fontSize = FONT_SIZE_MAP[settings.fontSize]
  }, [isLoading, settings.fontSize])

  useEffect(() => {
    if (isLoading) return
    const family = FONT_FAMILY_MAP[settings.fontFamily]
    if (family) {
      document.documentElement.style.setProperty('--font-sans', family)
    } else {
      document.documentElement.style.removeProperty('--font-sans')
    }
  }, [isLoading, settings.fontFamily])

  // Keep format-date's module cache in sync so pure (non-React) date helpers
  // format with the user's chosen format.
  useEffect(() => {
    if (isLoading) return
    setDateFormatPref(settings.dateFormat)
  }, [isLoading, settings.dateFormat])
}
