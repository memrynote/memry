import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { GeneralSettingsDTO } from '@/types/preload-types'

interface SettingsChangedEvent {
  key: string
  value: unknown
}

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
        const result = await invoke<GeneralSettingsDTO>('settings_get_general_settings')
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
    return subscribeEvent<SettingsChangedEvent>('settings-changed', (event) => {
      if (event.key === 'general') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<GeneralSettingsDTO>) }))
      }
    })
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<GeneralSettingsDTO>): Promise<boolean> => {
      try {
        const result = await invoke<{ success: boolean; error?: string }>(
          'settings_set_general_settings',
          updates as unknown as Record<string, unknown>
        )
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
