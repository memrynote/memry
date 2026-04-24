import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { TaskSettingsDTO } from '@/types/preload-types'

interface SettingsChangedEvent {
  key: string
  value: unknown
}

const DEFAULTS: TaskSettingsDTO = {
  defaultProjectId: null,
  defaultSortOrder: 'manual',
  weekStartDay: 'monday',
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
        const result = await invoke<TaskSettingsDTO>('settings_get_task_settings')
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load task preferences'))
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
    return subscribeEvent<SettingsChangedEvent>('settings-changed', (event) => {
      if (event.key === 'tasks') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<TaskSettingsDTO>) }))
      }
    })
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<TaskSettingsDTO>): Promise<boolean> => {
      try {
        const result = await invoke<{ success: boolean; error?: string }>(
          'settings_set_task_settings',
          updates as unknown as Record<string, unknown>
        )
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update task preferences'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
