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

const KAMI_THEME_ACCENT = '#1B365D'
const KAMI_FONT_SANS = "'Inter Variable', ui-sans-serif, -apple-system, system-ui, sans-serif"
const KAMI_FONT_SERIF = "'Newsreader', Charter, Georgia, 'Times New Roman', serif"

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
    document.documentElement.style.setProperty(
      '--user-accent-color',
      settings.theme === 'kami' ? KAMI_THEME_ACCENT : settings.accentColor
    )
  }, [isLoading, settings.accentColor, settings.theme])

  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.fontSize = FONT_SIZE_MAP[settings.fontSize]
  }, [isLoading, settings.fontSize])

  useEffect(() => {
    if (isLoading) return
    const rootStyle = document.documentElement.style

    if (settings.theme === 'kami') {
      rootStyle.setProperty('--font-sans', KAMI_FONT_SANS)
      rootStyle.setProperty('--font-serif', KAMI_FONT_SERIF)
      rootStyle.setProperty('--font-display', KAMI_FONT_SERIF)
      rootStyle.setProperty('--font-heading', KAMI_FONT_SANS)
      rootStyle.setProperty('--app-body-font', KAMI_FONT_SERIF)
      rootStyle.setProperty('--editor-body-font', KAMI_FONT_SERIF)
      return
    }

    const family = FONT_FAMILY_MAP[settings.fontFamily]
    if (family) {
      rootStyle.setProperty('--font-sans', family)
    } else {
      rootStyle.removeProperty('--font-sans')
    }

    rootStyle.removeProperty('--font-serif')
    rootStyle.removeProperty('--font-display')
    rootStyle.removeProperty('--font-heading')
    rootStyle.removeProperty('--app-body-font')
    rootStyle.removeProperty('--editor-body-font')
  }, [isLoading, settings.fontFamily, settings.theme])
}
