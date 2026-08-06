import { useState, useEffect, useCallback, useRef } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { trackRendererError } from '@/lib/telemetry-diagnostics'
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
  // Writes that land while the initial fetch is in flight; the fetch result is a
  // snapshot read before those writes, so they must win over it.
  const overridesRef = useRef<Partial<FeaturesSettings>>({})

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getFeaturesSettings()
        if (mounted) setFlags({ ...result, ...overridesRef.current })
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err))
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
        const value = event.value as Partial<FeaturesSettings>
        overridesRef.current = { ...overridesRef.current, ...value }
        setFlags((prev) => ({ ...prev, ...value }))
      }
    })
    return unsubscribe
  }, [])

  const setFlag = useCallback(async (feature: FeatureKey, value: boolean): Promise<boolean> => {
    const updates = { [feature]: value } as Partial<FeaturesSettings>
    try {
      const result = await window.api.settings.setFeaturesSettings(updates)
      if (result.success) {
        overridesRef.current = { ...overridesRef.current, ...updates }
        setFlags((prev) => ({ ...prev, ...updates }))
        return true
      }
      trackRendererError('feature_flag_toggle', result.error ?? 'Update failed')
      setError(result.error ?? 'Update failed')
      return false
    } catch (err) {
      trackRendererError('feature_flag_toggle', err)
      setError(extractErrorMessage(err))
      return false
    }
  }, [])

  const isEnabled = useCallback((feature: FeatureKey) => flags[feature], [flags])

  return { flags, isLoading, error, isEnabled, setFlag }
}
