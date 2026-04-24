import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { KeyboardShortcutsDTO } from '@/types/preload-types'

interface SettingsChangedEvent {
  key: string
  value: unknown
}

const DEFAULTS: KeyboardShortcutsDTO = {
  overrides: {},
  globalCapture: null
}

interface UseKeyboardSettingsReturn {
  settings: KeyboardShortcutsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<KeyboardShortcutsDTO>) => Promise<boolean>
  resetToDefaults: () => Promise<boolean>
}

export function useKeyboardSettings(): UseKeyboardSettingsReturn {
  const [settings, setSettings] = useState<KeyboardShortcutsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await invoke<KeyboardShortcutsDTO>('settings_get_keyboard_settings')
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load keyboard settings'))
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
      if (event.key === 'keyboard') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<KeyboardShortcutsDTO>) }))
      }
    })
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<KeyboardShortcutsDTO>): Promise<boolean> => {
      try {
        const result = await invoke<{ success: boolean; error?: string }>(
          'settings_set_keyboard_settings',
          updates as unknown as Record<string, unknown>
        )
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update keyboard settings'))
        return false
      }
    },
    []
  )

  const resetToDefaults = useCallback(async (): Promise<boolean> => {
    try {
      const result = await invoke<{ success: boolean; error?: string }>(
        'settings_reset_keyboard_settings'
      )
      if (result.success) {
        setSettings(DEFAULTS)
        return true
      }
      setError(result.error ?? 'Reset failed')
      return false
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to reset keyboard settings'))
      return false
    }
  }, [])

  return { settings, isLoading, error, updateSettings, resetToDefaults }
}
