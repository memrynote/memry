import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { KeyboardShortcutsDTO } from '../../../preload/index.d'

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
        setIsLoading(true)
        setError(null)
        const result = await window.api.settings.getKeyboardSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load keyboard settings'))
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    load()
    return () => {
      mounted = false
    }
  }, [])

  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'keyboard') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<KeyboardShortcutsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<KeyboardShortcutsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setKeyboardSettings(updates)
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
      const result = await window.api.settings.resetKeyboardSettings()
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
