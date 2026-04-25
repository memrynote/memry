import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { GeneralSettingsDTO } from '@/types/preload-types'

interface SettingsChangedEvent {
  key: string
  value: unknown
}

const GENERAL_SETTINGS_KEY = 'general'

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

function parseStoredSettings(raw: string | null): GeneralSettingsDTO {
  if (!raw) return DEFAULTS
  try {
    const parsed = JSON.parse(raw) as Partial<GeneralSettingsDTO>
    return { ...DEFAULTS, ...parsed }
  } catch {
    return DEFAULTS
  }
}

export function useGeneralSettings(): UseGeneralSettingsReturn {
  const [settings, setSettings] = useState<GeneralSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const settingsRef = useRef<GeneralSettingsDTO>(DEFAULTS)

  useEffect(() => {
    settingsRef.current = settings
  }, [settings])

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const raw = await invoke<string | null>('settings_get', {
          input: { key: GENERAL_SETTINGS_KEY }
        })
        if (!mounted) return
        const merged = parseStoredSettings(raw)
        setSettings(merged)
        settingsRef.current = merged
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
      if (event.key === GENERAL_SETTINGS_KEY) {
        setSettings((prev) => {
          const next = { ...prev, ...(event.value as Partial<GeneralSettingsDTO>) }
          settingsRef.current = next
          return next
        })
      }
    })
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<GeneralSettingsDTO>): Promise<boolean> => {
      const next = { ...settingsRef.current, ...updates }
      try {
        await invoke<void>('settings_set', {
          input: { key: GENERAL_SETTINGS_KEY, value: JSON.stringify(next) }
        })
        setSettings(next)
        settingsRef.current = next
        return true
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update general settings'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
