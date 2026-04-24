/**
 * useNoteEditorSettings Hook
 *
 * Manages note editor settings including toolbar display mode.
 * Provides reactive updates when settings change.
 *
 * @module hooks/use-note-editor-settings
 */

import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { NoteEditorSettings } from '@/types/preload-types'

interface UseNoteEditorSettingsReturn {
  /** Current note editor settings */
  settings: NoteEditorSettings
  /** Whether settings are being loaded */
  isLoading: boolean
  /** Error message if settings failed to load */
  error: string | null
  /** Update note editor settings */
  updateSettings: (updates: Partial<NoteEditorSettings>) => Promise<boolean>
  /** Set the toolbar mode (convenience method) */
  setToolbarMode: (mode: 'floating' | 'sticky') => Promise<boolean>
}

/**
 * Hook for managing note editor settings.
 *
 * @example
 * ```tsx
 * const { settings, setToolbarMode } = useNoteEditorSettings()
 *
 * // Get the current toolbar mode
 * const isStickyToolbar = settings.toolbarMode === 'sticky'
 *
 * // Toggle toolbar mode
 * await setToolbarMode(isStickyToolbar ? 'floating' : 'sticky')
 * ```
 */
export function useNoteEditorSettings(): UseNoteEditorSettingsReturn {
  const [settings, setSettings] = useState<NoteEditorSettings>({ toolbarMode: 'floating' })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load settings on mount
  useEffect(() => {
    let mounted = true

    const loadSettings = async (): Promise<void> => {
      try {
        const result = await window.api.settings.getNoteEditorSettings()
        if (mounted) {
          setSettings(result)
        }
      } catch (err) {
        if (mounted) {
          setError(extractErrorMessage(err, 'Failed to load note editor settings'))
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    void loadSettings()

    return () => {
      mounted = false
    }
  }, [])

  // Listen for settings changes
  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'noteEditor') {
        setSettings((prev) => ({
          ...prev,
          ...(event.value as Partial<NoteEditorSettings>)
        }))
      }
    })

    return unsubscribe
  }, [])

  // Update settings
  const updateSettings = useCallback(
    async (updates: Partial<NoteEditorSettings>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setNoteEditorSettings(updates)
        if (result.success) {
          // Optimistically update local state
          setSettings((prev) => ({ ...prev, ...updates }))
          return true
        }
        setError(extractErrorMessage(result.error, 'Failed to update settings'))
        return false
      } catch (err) {
        setError(extractErrorMessage(err, 'Failed to update settings'))
        return false
      }
    },
    []
  )

  // Convenience method for setting toolbar mode
  const setToolbarMode = useCallback(
    async (mode: 'floating' | 'sticky'): Promise<boolean> => {
      return updateSettings({ toolbarMode: mode })
    },
    [updateSettings]
  )

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    setToolbarMode
  }
}

export default useNoteEditorSettings
