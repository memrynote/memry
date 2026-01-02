/**
 * useTabPreferences Hook
 *
 * Manages tab behavior preferences persisted to the database.
 * Provides reactive updates when settings change.
 * Works in conjunction with the TabsContext for immediate effect.
 *
 * @module hooks/use-tab-preferences
 */

import { useState, useEffect, useCallback } from 'react'
import type { TabSettings } from '@/contexts/tabs/types'
import { DEFAULT_TAB_SETTINGS } from '@/contexts/tabs/helpers'

interface UseTabPreferencesReturn {
  /** Current tab settings */
  settings: TabSettings
  /** Whether settings are being loaded */
  isLoading: boolean
  /** Error message if settings failed to load */
  error: string | null
  /** Update tab settings (persists to database) */
  updateSettings: (updates: Partial<TabSettings>) => Promise<boolean>
  /** Set preview mode (convenience method) */
  setPreviewMode: (enabled: boolean) => Promise<boolean>
  /** Set open in new tab behavior */
  setOpenInNewTab: (value: TabSettings['openInNewTab']) => Promise<boolean>
  /** Set show pinned tabs first */
  setShowPinnedTabsFirst: (enabled: boolean) => Promise<boolean>
  /** Set restore session on start */
  setRestoreSessionOnStart: (enabled: boolean) => Promise<boolean>
  /** Set tab close button behavior */
  setTabCloseButton: (value: TabSettings['tabCloseButton']) => Promise<boolean>
}

/**
 * Hook for managing tab preferences persisted to the database.
 *
 * @example
 * ```tsx
 * const { settings, setPreviewMode, updateSettings } = useTabPreferences()
 *
 * // Toggle preview mode
 * await setPreviewMode(true)
 *
 * // Update multiple settings
 * await updateSettings({ previewMode: true, openInNewTab: 'always' })
 * ```
 */
export function useTabPreferences(): UseTabPreferencesReturn {
  const [settings, setSettings] = useState<TabSettings>(DEFAULT_TAB_SETTINGS)
  const [isLoading, setIsLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Load settings on mount
  useEffect(() => {
    let mounted = true

    const loadSettings = async (): Promise<void> => {
      try {
        setIsLoading(true)
        setError(null)
        const result = await window.api.settings.getTabSettings()
        if (mounted) {
          setSettings(result)
        }
      } catch (err) {
        if (mounted) {
          setError(err instanceof Error ? err.message : 'Failed to load tab settings')
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

  // Listen for settings changes (from other windows or components)
  useEffect(() => {
    const unsubscribe = window.api.onSettingsChanged((event) => {
      if (event.key === 'tabs') {
        // Full tab settings update
        setSettings((prev) => ({
          ...prev,
          ...(event.value as Partial<TabSettings>)
        }))
      }
    })

    return unsubscribe
  }, [])

  // Update settings
  const updateSettings = useCallback(async (updates: Partial<TabSettings>): Promise<boolean> => {
    try {
      const result = await window.api.settings.setTabSettings(updates)
      if (result.success) {
        // Optimistically update local state
        setSettings((prev) => ({ ...prev, ...updates }))
        return true
      }
      setError(result.error ?? 'Failed to update settings')
      return false
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to update settings')
      return false
    }
  }, [])

  // Convenience methods
  const setPreviewMode = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      return updateSettings({ previewMode: enabled })
    },
    [updateSettings]
  )

  const setOpenInNewTab = useCallback(
    async (value: TabSettings['openInNewTab']): Promise<boolean> => {
      return updateSettings({ openInNewTab: value })
    },
    [updateSettings]
  )

  const setShowPinnedTabsFirst = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      return updateSettings({ showPinnedTabsFirst: enabled })
    },
    [updateSettings]
  )

  const setRestoreSessionOnStart = useCallback(
    async (enabled: boolean): Promise<boolean> => {
      return updateSettings({ restoreSessionOnStart: enabled })
    },
    [updateSettings]
  )

  const setTabCloseButton = useCallback(
    async (value: TabSettings['tabCloseButton']): Promise<boolean> => {
      return updateSettings({ tabCloseButton: value })
    },
    [updateSettings]
  )

  return {
    settings,
    isLoading,
    error,
    updateSettings,
    setPreviewMode,
    setOpenInNewTab,
    setShowPinnedTabsFirst,
    setRestoreSessionOnStart,
    setTabCloseButton
  }
}

export default useTabPreferences
