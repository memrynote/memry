import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { mergeSettingsPatch } from '@/lib/settings-patch'
import type { KeyboardShortcutsDTO } from '../../../preload/index.d'
import { getI18n } from 'react-i18next'

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
        const result = await window.api.settings.getKeyboardSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted)
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadKeyboardSettings')
            )
          )
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
      if (event.key === 'keyboard') {
        setSettings((prev) =>
          mergeSettingsPatch(prev, event.value as Partial<KeyboardShortcutsDTO>)
        )
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
        setError(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateKeyboardSettings')
          )
        )
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
      setError(
        extractErrorMessage(
          err,
          getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToResetKeyboardSettings')
        )
      )
      return false
    }
  }, [])

  return { settings, isLoading, error, updateSettings, resetToDefaults }
}
