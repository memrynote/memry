import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { BackupSettingsDTO } from '../../../preload/index.d'

const DEFAULTS: BackupSettingsDTO = {
  autoBackup: false,
  frequencyHours: 24,
  maxBackups: 5,
  lastBackupAt: null
}

interface UseBackupSettingsReturn {
  settings: BackupSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<BackupSettingsDTO>) => Promise<boolean>
}

export function useBackupSettings(): UseBackupSettingsReturn {
  const [settings, setSettings] = useState<BackupSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await window.api.settings.getBackupSettings()
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load backup settings'))
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
      if (event.key === 'backup') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<BackupSettingsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<BackupSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setBackupSettings(updates)
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update backup settings'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
