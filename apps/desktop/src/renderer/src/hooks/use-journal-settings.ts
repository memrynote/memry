/**
 * useJournalSettings Hook
 *
 * Manages journal settings including default template preference.
 * Provides reactive updates when settings change.
 *
 * @module hooks/use-journal-settings
 */

import { useState, useEffect, useCallback } from 'react'
import { extractErrorMessage } from '@/lib/ipc-error'
import type { JournalSettings } from '../../../preload/index.d'

interface UseJournalSettingsReturn {
  /** Current journal settings */
  settings: JournalSettings
  /** Whether settings are being loaded */
  isLoading: boolean
  /** Error message if settings failed to load */
  error: string | null
  /** Update journal settings */
  updateSettings: (updates: Partial<JournalSettings>) => Promise<boolean>
  /** Set the default template (convenience method) */
  setDefaultTemplate: (templateId: string | null) => Promise<boolean>
}

/**
 * Hook for managing journal settings.
 *
 * @example
 * ```tsx
 * const { settings, setDefaultTemplate } = useJournalSettings()
 *
 * // Get the default template
 * const defaultTemplateId = settings.defaultTemplate
 *
 * // Set a new default template
 * await setDefaultTemplate('morning-pages')
 *
 * // Clear the default template
 * await setDefaultTemplate(null)
 * ```
 */
export function useJournalSettings(): UseJournalSettingsReturn {
  const [settings, setSettings] = useState<JournalSettings>({
    defaultTemplate: null,
    showSchedule: true,
    showTasks: true,
    showAIConnections: true,
    showStatsFooter: false
  })
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load settings on mount
  useEffect(() => {
    let mounted = true

    const loadSettings = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await window.api.settings.getJournalSettings()
        if (mounted) {
          setSettings(result)
        }
      } catch (err) {
        if (mounted) {
          setError(extractErrorMessage(err, 'Failed to load journal settings'))
        }
      } finally {
        if (mounted) {
          setIsLoading(false)
        }
      }
    }

    loadSettings()

    return () => {
      mounted = false
    }
  }, [])

  // Listen for settings changes
  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'journal') {
        // Full journal settings update
        setSettings((prev) => ({
          ...prev,
          ...(event.value as Partial<JournalSettings>)
        }))
      }
    })

    return unsubscribe
  }, [])

  // Update settings
  const updateSettings = useCallback(
    async (updates: Partial<JournalSettings>): Promise<boolean> => {
      try {
        const result = await window.api.settings.setJournalSettings(updates)
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

  // Convenience method for setting default template
  const setDefaultTemplate = useCallback(
    async (templateId: string | null): Promise<boolean> => {
      return updateSettings({ defaultTemplate: templateId })
    },
    [updateSettings]
  )

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    setDefaultTemplate
  }
}

export default useJournalSettings
