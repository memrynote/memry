import { getI18n } from 'react-i18next'
import { mergeSettingsPatch } from '@/lib/settings-patch'
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
  /** Set (or clear, with null) the template for one weekday, 0 = Sunday */
  setWeekdayTemplate: (weekday: number, templateId: string | null) => Promise<boolean>
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
    weekdayTemplates: {},
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
        const result = await window.api.settings.getJournalSettings()
        if (mounted) {
          setSettings(result)
        }
      } catch (err) {
        if (mounted) {
          setError(
            extractErrorMessage(
              err,
              getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToLoadJournalSettings')
            )
          )
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
      if (event.key === 'journal') {
        // Full journal settings update
        setSettings((prev) => mergeSettingsPatch(prev, event.value as Partial<JournalSettings>))
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
          // Optimistically update local state. The weekday map is patched a day
          // at a time — main merges it into the stored map and broadcasts the
          // whole thing back — so spreading the patch wholesale here would drop
          // every other day until that broadcast arrives.
          setSettings((prev) => ({
            ...prev,
            ...updates,
            ...(updates.weekdayTemplates
              ? { weekdayTemplates: { ...prev.weekdayTemplates, ...updates.weekdayTemplates } }
              : {})
          }))
          return true
        }
        setError(
          extractErrorMessage(
            result.error,
            getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToUpdateSettings')
          )
        )
        return false
      } catch (err) {
        setError(
          extractErrorMessage(
            err,
            getI18n().getFixedT(null, 'journal')('phaseI.errors.failedToUpdateSettings')
          )
        )
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

  const setWeekdayTemplate = useCallback(
    async (weekday: number, templateId: string | null): Promise<boolean> => {
      // Clearing writes an explicit null rather than dropping the key: the entry
      // is what the per-day sync clock refers to.
      return updateSettings({ weekdayTemplates: { [String(weekday)]: templateId } })
    },
    [updateSettings]
  )

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    setDefaultTemplate,
    setWeekdayTemplate
  }
}

export default useJournalSettings
