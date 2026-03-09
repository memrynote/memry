import { useEffect } from 'react'
import { useTheme } from 'next-themes'
import { useGeneralSettings } from './use-general-settings'
import { createLogger } from '@/lib/logger'

const log = createLogger('ThemeSync')

export function useThemeSync(): void {
  const { settings } = useGeneralSettings()
  const { setTheme } = useTheme()

  useEffect(() => {
    log.debug('Syncing theme:', settings.theme)
    setTheme(settings.theme)
  }, [settings.theme, setTheme])

  useEffect(() => {
    document.documentElement.style.setProperty('--user-accent-color', settings.accentColor)
  }, [settings.accentColor])
}
