import { useCallback, useEffect, useState } from 'react'
import {
  SIDEBAR_SORT_DEFAULTS,
  resolveSortMode,
  type SidebarSortMode,
  type SidebarSortSurface
} from '@memry/contracts/sidebar-sort'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('SidebarSortMode')

/** Mirrors SIDEBAR_SORT_SETTINGS_KEY in the main process. */
const SIDEBAR_SORT_SETTINGS_KEY = 'sidebar.sortModes'

interface UseSidebarSortModeResult {
  mode: SidebarSortMode
  setMode: (next: SidebarSortMode) => Promise<void>
  /**
   * False until the stored value has arrived. A caller migrating an older
   * per-device preference must wait for this, or it would compare against the
   * default that is showing only because the read has not landed yet.
   */
  isLoaded: boolean
  error: string | null
}

/**
 * One sidebar section's sort mode, persisted per vault and synced per surface.
 *
 * Starts at the surface's default — the order that surface already had before
 * sort modes existed — so the first paint matches what the user saw yesterday
 * even before the stored value arrives.
 */
export function useSidebarSortMode(surface: SidebarSortSurface): UseSidebarSortModeResult {
  const [mode, setModeState] = useState<SidebarSortMode>(SIDEBAR_SORT_DEFAULTS[surface])
  const [error, setError] = useState<string | null>(null)
  const [isLoaded, setIsLoaded] = useState(false)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const modes = await window.api?.settings?.getSidebarSortModes?.()
        if (mounted && modes) setModeState(resolveSortMode(surface, modes[surface]))
      } catch (err) {
        log.error('Failed to load sidebar sort mode', err)
      } finally {
        if (mounted) setIsLoaded(true)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [surface])

  // A change synced in from another device, or made in another window.
  useEffect(() => {
    // Guarded: a host that does not expose the settings channel must leave the
    // section rendering in its default order, not tear the sidebar down.
    try {
      const unsubscribe = window.api?.onSettingsChanged?.((event) => {
        if (event.key !== SIDEBAR_SORT_SETTINGS_KEY) return
        const modes = event.value as Partial<Record<SidebarSortSurface, SidebarSortMode>>
        setModeState(resolveSortMode(surface, modes?.[surface]))
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } catch (err) {
      log.error('Failed to subscribe to sidebar sort mode changes', err)
      return undefined
    }
  }, [surface])

  const setMode = useCallback(
    async (next: SidebarSortMode): Promise<void> => {
      const previous = mode
      const failureMessage = getI18n().getFixedT(
        null,
        'common'
      )('phaseF.componentsAppSidebar.sortSaveFailed')
      // Optimistic: the list reorders on click, not on the IPC round-trip.
      setModeState(next)
      setError(null)
      try {
        const result = await window.api.settings.setSidebarSortMode(surface, next)
        if (!result.success) {
          setModeState(previous)
          setError(result.error ?? failureMessage)
        }
      } catch (err) {
        setModeState(previous)
        setError(extractErrorMessage(err, failureMessage))
      }
    },
    [mode, surface]
  )

  return { mode, setMode, isLoaded, error }
}
