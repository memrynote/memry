import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { mergeSettingsPatch } from '@/lib/settings-patch'
import { INBOX_SETTINGS_DEFAULTS, type InboxSettings } from '@memry/contracts/settings-schemas'
import { getI18n } from 'react-i18next'

interface UseInboxPreferencesReturn {
  settings: InboxSettings
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<InboxSettings>) => Promise<boolean>
}

export function useInboxPreferences(): UseInboxPreferencesReturn {
  const [settings, setSettings] = useState<InboxSettings>(INBOX_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getInboxSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted)
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToLoadInboxPreferences')
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
      if (event.key === 'inbox') {
        setSettings((prev) => mergeSettingsPatch(prev, event.value as Partial<InboxSettings>))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(async (updates: Partial<InboxSettings>): Promise<boolean> => {
    try {
      const result = await window.api.settings.setInboxSettings(updates)
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
          getI18n().getFixedT(null, 'inbox')('phaseI.errors.failedToUpdateInboxPreferences')
        )
      )
      return false
    }
  }, [])

  return { settings, isLoading, error, updateSettings }
}
