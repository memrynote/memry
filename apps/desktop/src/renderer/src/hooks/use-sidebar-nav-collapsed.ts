import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('SidebarNavCollapsed')

/** Mirrors SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY in the main process. */
const SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY = 'sidebar.navCollapsed'

interface UseSidebarNavCollapsedResult {
  /** Whether the user folded the sidebar's top nav block away. */
  collapsed: boolean
  setCollapsed: (next: boolean) => void
  error: string | null
}

/**
 * Whether the sidebar's top nav block is collapsed, persisted per vault and synced.
 *
 * Starts expanded — the nav every build before this toggle drew — so the first
 * paint is the sidebar the user saw yesterday even before the stored value
 * arrives.
 */
export function useSidebarNavCollapsed(): UseSidebarNavCollapsedResult {
  const [collapsed, setCollapsedState] = useState<boolean>(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const stored = await window.api?.settings?.getSidebarNavCollapsed?.()
        if (mounted && typeof stored === 'boolean') setCollapsedState(stored)
      } catch (err) {
        log.error('Failed to load sidebar nav collapsed flag', err)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  // A toggle synced in from another device, or made in another window.
  useEffect(() => {
    // Guarded: a host without the settings channel must leave the nav
    // expanded, not tear the sidebar down.
    try {
      const unsubscribe = window.api?.onSettingsChanged?.((event) => {
        if (event.key !== SIDEBAR_NAV_COLLAPSED_SETTINGS_KEY) return
        // Typed, not truthy: `false` is the value that expands the nav again,
        // and a truthy check would drop every one of those merges on the floor.
        if (typeof event.value === 'boolean') setCollapsedState(event.value)
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } catch (err) {
      log.error('Failed to subscribe to sidebar nav collapsed changes', err)
      return undefined
    }
  }, [])

  const setCollapsed = useCallback(
    (next: boolean): void => {
      const previous = collapsed
      // Optimistic: the nav folds on the click, not after the IPC round-trip.
      setCollapsedState(next)
      setError(null)

      const failureMessage = getI18n().getFixedT(null, 'notes')('tree.nav.saveFailed')

      void (async () => {
        try {
          const result = await window.api.settings.setSidebarNavCollapsed(next)
          if (!result.success) {
            setCollapsedState(previous)
            setError(result.error ?? failureMessage)
          }
        } catch (err) {
          setCollapsedState(previous)
          setError(extractErrorMessage(err, failureMessage))
        }
      })()
    },
    [collapsed]
  )

  return { collapsed, setCollapsed, error }
}
