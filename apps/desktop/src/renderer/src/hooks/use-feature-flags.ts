import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import {
  FEATURES_SETTINGS_DEFAULTS,
  type FeaturesSettings
} from '@memry/contracts/settings-schemas'
import type { FeatureKey } from '@memry/contracts/feature-flags'

interface UseFeatureFlagsReturn {
  flags: FeaturesSettings
  isLoading: boolean
  error: string | null
  isEnabled: (feature: FeatureKey) => boolean
  setFlag: (feature: FeatureKey, value: boolean) => Promise<boolean>
}

export function useFeatureFlags(): UseFeatureFlagsReturn {
  const [flags, setFlags] = useState<FeaturesSettings>(FEATURES_SETTINGS_DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getFeaturesSettings()
        if (mounted) setFlags(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load features'))
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
      if (event.key === 'features') {
        setFlags((prev) => ({ ...prev, ...(event.value as Partial<FeaturesSettings>) }))
      }
    })
    return unsubscribe
  }, [])

  const setFlag = useCallback(async (feature: FeatureKey, value: boolean): Promise<boolean> => {
    const updates = { [feature]: value } as Partial<FeaturesSettings>
    try {
      const result = await window.api.settings.setFeaturesSettings(updates)
      if (result.success) {
        setFlags((prev) => ({ ...prev, ...updates }))
        return true
      }
      setError(result.error ?? 'Update failed')
      return false
    } catch (err) {
      setError(extractErrorMessage(err, 'Failed to update features'))
      return false
    }
  }, [])

  const isEnabled = useCallback((feature: FeatureKey) => flags[feature], [flags])

  return { flags, isLoading, error, isEnabled, setFlag }
}
