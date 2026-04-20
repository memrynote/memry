import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  CALENDAR_SETTINGS_DEFAULTS,
  type CalendarSettings
} from '@memry/contracts/settings-schemas'

export type DayCellClickBehavior = 'journal' | 'calendar'

interface UseCalendarPreferencesReturn {
  settings: CalendarSettings
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<CalendarSettings>) => Promise<boolean>
}

export function useCalendarPreferences(): UseCalendarPreferencesReturn {
  const [settings, setSettings] = useState<CalendarSettings>(CALENDAR_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getCalendarSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load calendar preferences'))
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'calendar') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<CalendarSettings>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<CalendarSettings>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setCalendarSettings(updates)
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update calendar preferences'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}

export function resolveDayCellClickBehavior(
  settings: CalendarSettings,
  isCalendarTabActive: boolean
): DayCellClickBehavior {
  if (isCalendarTabActive && settings.calendarPageClickOverride !== 'inherit') {
    return settings.calendarPageClickOverride
  }
  return settings.dayCellClickBehavior
}
