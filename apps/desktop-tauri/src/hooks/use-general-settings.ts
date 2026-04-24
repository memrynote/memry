import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { GeneralSettingsDTO } from '../../../preload/index.d'

const DEFAULTS: GeneralSettingsDTO = {
  theme: 'system',
  fontSize: 'medium',
  fontFamily: 'system',
  accentColor: '#6366f1',
  startOnBoot: false,
  language: 'en',
  onboardingCompleted: false,
  createInSelectedFolder: true,
  clockFormat: '12h'
}

interface UseGeneralSettingsReturn {
  settings: GeneralSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<GeneralSettingsDTO>) => Promise<boolean>
}

export function useGeneralSettings(): UseGeneralSettingsReturn {
  const [settings, setSettings] = useState<GeneralSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getGeneralSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load general settings'))
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
      if (event.key === 'general') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<GeneralSettingsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<GeneralSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setGeneralSettings(updates)
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update general settings'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
