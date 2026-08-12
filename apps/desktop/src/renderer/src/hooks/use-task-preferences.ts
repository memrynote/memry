import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { mergeSettingsPatch } from '@/lib/settings-patch'
import type { TaskSettingsDTO } from '../../../preload/index.d'
import { getI18n } from 'react-i18next'

const DEFAULTS: TaskSettingsDTO = {
  defaultProjectId: null,
  defaultSortOrder: 'manual',
  defaultView: 'all',
  staleInboxDays: 7
}

interface UseTaskPreferencesReturn {
  settings: TaskSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<TaskSettingsDTO>) => Promise<boolean>
}

export function useTaskPreferences(): UseTaskPreferencesReturn {
  const [settings, setSettings] = useState<TaskSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getTaskSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted)
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToLoadTaskPreferences')
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
      if (event.key === 'tasks') {
        setSettings((prev) => mergeSettingsPatch(prev, event.value as Partial<TaskSettingsDTO>))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<TaskSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setTaskSettings(updates)
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
            getI18n().getFixedT(null, 'tasks')('phaseI.errors.failedToUpdateTaskPreferences')
          )
        )
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
