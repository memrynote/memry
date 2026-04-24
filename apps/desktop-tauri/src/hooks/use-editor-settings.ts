import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import { invoke } from '@/lib/ipc/invoke'
import { subscribeEvent } from '@/lib/ipc/forwarder'
import type { EditorSettingsDTO } from '@/types/preload-types'

interface SettingsChangedEvent {
  key: string
  value: unknown
}

const DEFAULTS: EditorSettingsDTO = {
  width: 'medium',
  spellCheck: true,
  autoSaveDelay: 1000,
  showWordCount: false,
  toolbarMode: 'floating'
}

interface UseEditorSettingsReturn {
  settings: EditorSettingsDTO
  isLoading: boolean
  error: string | null
  updateSettings: (updates: Partial<EditorSettingsDTO>) => Promise<boolean>
}

export function useEditorSettings(): UseEditorSettingsReturn {
  const [settings, setSettings] = useState<EditorSettingsDTO>(DEFAULTS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const result = await invoke<EditorSettingsDTO>('settings_get_editor_settings')
        if (mounted) setSettings(result)
      } catch (err) {
        if (mounted) setError(extractErrorMessage(err, 'Failed to load editor settings'))
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
      if (event.key === 'editor') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<EditorSettingsDTO>) }))
      }
    })
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<EditorSettingsDTO>): Promise<boolean> => {
      try {
        const result = await invoke<{ success: boolean; error?: string }>(
          'settings_set_editor_settings',
          updates as unknown as Record<string, unknown>
        )
        if (result.success) {
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(result.error ?? 'Update failed')
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update editor settings'))
        return false
      }
    },
    []
  )

  return { settings, isLoading, error, updateSettings }
}
