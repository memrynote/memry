import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { EditorSettingsDTO } from '../../../preload/index.d'

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
        const result = await window.api.settings.getEditorSettings()
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
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'editor') {
        setSettings((prev) => ({ ...prev, ...(event.value as Partial<EditorSettingsDTO>) }))
      }
    })
    return unsubscribe
  }, [])

  const updateSettings = useCallback(
    async (updates: Partial<EditorSettingsDTO>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setEditorSettings(updates)
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
