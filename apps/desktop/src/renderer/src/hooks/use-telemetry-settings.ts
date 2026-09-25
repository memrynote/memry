import { useCallback, useEffect, useState } from 'react'

import { createLogger } from '@/lib/logger'

const logger = createLogger('UseTelemetrySettings')

interface TelemetryApi {
  getSettings: () => Promise<{ enabled: boolean; autoSendDiagnostics?: boolean }>
  setEnabled: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
  setAutoSendDiagnostics?: (enabled: boolean) => Promise<{ success: boolean; error?: string }>
}

export const getTelemetryApi = (): TelemetryApi | null => {
  const api = (window as Window & { api?: { telemetry?: TelemetryApi } }).api
  return api?.telemetry ?? null
}

export interface UseTelemetrySettingsReturn {
  enabled: boolean
  isLoading: boolean
  setEnabled: (enabled: boolean) => Promise<boolean>
  /** Error screens send a diagnostic report without asking. Defaults to on. */
  autoSendDiagnostics: boolean
  setAutoSendDiagnostics: (enabled: boolean) => Promise<boolean>
}

/** Reads the auto-send flag at the moment it is needed; absent means on. */
export async function isAutoSendDiagnosticsEnabled(): Promise<boolean> {
  const api = getTelemetryApi()
  if (!api) return false
  try {
    const result = await api.getSettings()
    return result.autoSendDiagnostics !== false
  } catch (error) {
    logger.warn('Failed to read auto-send diagnostics setting', error)
    return false
  }
}

export function useTelemetrySettings(): UseTelemetrySettingsReturn {
  const [enabled, setEnabledState] = useState(false)
  const [autoSendDiagnostics, setAutoSendState] = useState(true)
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
        if (mounted) {
          setEnabledState(result.enabled)
          setAutoSendState(result.autoSendDiagnostics !== false)
        }
      } catch (error) {
        logger.warn('Failed to load telemetry settings; falling back to disabled', error)
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

  const setAutoSendDiagnostics = useCallback(async (next: boolean): Promise<boolean> => {
    const api = getTelemetryApi()
    if (!api?.setAutoSendDiagnostics) return false
    try {
      const result = await api.setAutoSendDiagnostics(next)
      if (!result.success) {
        logger.warn('Failed to update auto-send diagnostics setting', { error: result.error })
        return false
      }
      setAutoSendState(next)
      return true
    } catch (error) {
      logger.warn('Failed to update auto-send diagnostics setting', error)
      return false
    }
  }, [])

  return { enabled, isLoading, setEnabled, autoSendDiagnostics, setAutoSendDiagnostics }
}
