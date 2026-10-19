import { useEffect } from 'react'
import { useGeneralSettings } from './use-general-settings'

/**
 * Paints the user's accent in a window that skips the main window's full
 * theme sync (the sticky and its edge tab).
 */
export function useUserAccentColor(): void {
  const { settings, isLoading } = useGeneralSettings()
  useEffect(() => {
    if (isLoading) return
    document.documentElement.style.setProperty('--user-accent-color', settings.accentColor)
  }, [isLoading, settings.accentColor])
}
