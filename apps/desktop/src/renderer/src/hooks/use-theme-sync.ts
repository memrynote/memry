import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useGeneralSettings } from './use-general-settings'
import { createLogger } from '@/lib/logger'

const log = createLogger('ThemeSync')

const FONT_SIZE_MAP = {
  small: '14px',
  medium: '16px',
  large: '18px'
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

  useEffect(() => {
    if (isLoading) return
    log.debug('Syncing theme:', settings.theme)
    setTheme(settings.theme)
  }, [isLoading, settings.theme, setTheme])

  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.setProperty('--user-accent-color', settings.accentColor)
  }, [isLoading, settings.accentColor])

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
}
