import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { SyncSettingsDTO } from '../../../preload/index.d'

const DEFAULTS: SyncSettingsDTO = {
  enabled: true,
  autoSync: true
}

interface UseSyncSettingsReturn {
  settings: SyncSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<SyncSettingsDTO>) => Promise<boolean>
}

export function useSyncSettings(): UseSyncSettingsReturn {
  const [settings, setSettings] = useState<SyncSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await window.api.settings.getSyncSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load sync settings'))
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
      if (event.key === 'sync') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<SyncSettingsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<SyncSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setSyncSettings(updates)
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update sync settings'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
