import { useCallback, useEffect, useState } from 'react'

import { createLogger } from '@/lib/logger'

const logger = createLogger('UseTelemetrySettings')

interface TelemetryApi {
  getSettings: () => Promise<{ enabled: boolean }>
  setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
}

const getTelemetryApi = (): TelemetryApi | null => {
  const api = (window as Window & { api?: { telemetry?: TelemetryApi } }).api
  return api?.telemetry ?? null
}

export interface UseTelemetrySettingsReturn {
  enabled: boolean
  isLoading: boolean
  setEnabled: (enabled: boolean) => Promise<boolean>
}

export function useTelemetrySettings(): UseTelemetrySettingsReturn {
  const [enabled, setEnabledState] = useState(true)
  const [isLoading, setIsLoading] = useState(true)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      const api = getTelemetryApi()
      if (!api) {
        if (mounted) setIsLoading(false)
        return
      }
      try {
        const result = await api.getSettings()
        if (mounted) setEnabledState(result.enabled)
      } catch (error) {
        logger.warn('Failed to load telemetry settings; falling back to enabled', error)
      } finally {
        if (mounted) setIsLoading(false)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  const setEnabled = useCallback(async (next: boolean): Promise<boolean> => {
    const api = getTelemetryApi()
    if (!api) return false
    try {
      const result = await api.setEnabled(next)
      if (!result.success) {
        logger.warn('Failed to update telemetry setting', { error: result.error })
        return false
      }
      setEnabledState(next)
      return true
    } catch (error) {
      logger.warn('Failed to update telemetry setting', error)
      return false
    }
  }, [])

  return { enabled, isLoading, setEnabled }
}
