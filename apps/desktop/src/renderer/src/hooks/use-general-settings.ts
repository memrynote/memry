import { useState, useEffect, useCallback } from 'react'
import { GENERAL_SETTINGS_DEFAULTS } from '@memry/contracts/settings-schemas'
import { extractErrorMessage } from '@/lib/ipc-error'
import { mergeSettingsPatch } from '@/lib/settings-patch'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
import type { GeneralSettingsDTO } from '../../../preload/index.d'
import { getI18n } from 'react-i18next'

const DEFAULTS: GeneralSettingsDTO = GENERAL_SETTINGS_DEFAULTS

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
        if (mounted)
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToLoadGeneralSettings')
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
      if (event.key === 'general') {
        setSettings((prev) => mergeSettingsPatch(prev, event.value as Partial<GeneralSettingsDTO>))
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
        trackRendererError('settings_save', result.error ?? 'Update failed')
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        trackRendererError('settings_save', err)
        setError(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'settings')('phaseI.errors.failedToUpdateGeneralSettings')
          )
        )
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
