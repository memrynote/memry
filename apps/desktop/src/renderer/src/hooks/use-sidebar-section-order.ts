import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'
import { trackWorkspaceLoad } from '@/lib/workspace-load-tracker'

const log = createLogger('SidebarSectionOrder')

/** Mirror the settings keys in main/settings/sidebar-section-order-store.ts. */
const SIDEBAR_SECTION_ORDER_SETTINGS_KEY = 'sidebar.sectionOrder'
const SIDEBAR_RAIL_ORDER_SETTINGS_KEY = 'sidebar.railOrder'

interface OrderSource {
  key: string
  load: () => Promise<string[]> | undefined
  save: (next: string[]) => Promise<{ success: boolean; error?: string }>
}

const sectionSource: OrderSource = {
  key: SIDEBAR_SECTION_ORDER_SETTINGS_KEY,
  load: () => window.api?.settings?.getSidebarSectionOrder?.(),
  save: (next) => window.api.settings.setSidebarSectionOrder(next)
}

const railSource: OrderSource = {
  key: SIDEBAR_RAIL_ORDER_SETTINGS_KEY,
  load: () => window.api?.settings?.getSidebarRailOrder?.(),
  save: (next) => window.api.settings.setSidebarRailOrder(next)
}

interface UseSidebarSectionOrderResult {
  /** Ids the user dragged into place; empty means the build's default order. */
  order: string[]
  setOrder: (next: string[]) => void
  error: string | null
}

/**
 * The order the sidebar's sections render in, persisted per vault and synced.
 *
 * Starts empty — the sidebar's own default order — so the first paint is the
 * order the user saw yesterday even before the stored value arrives.
 */
export function useSidebarSectionOrder(): UseSidebarSectionOrderResult {
  return useSyncedIdOrder(sectionSource)
}

/** The order of the app rail's page icons (home, inbox, ...), per vault and synced. */
export function useSidebarRailOrder(): UseSidebarSectionOrderResult {
  return useSyncedIdOrder(railSource)
}

function useSyncedIdOrder(source: OrderSource): UseSidebarSectionOrderResult {
  const [order, setOrderState] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const stored = await trackWorkspaceLoad(source.load())
        if (mounted && Array.isArray(stored)) setOrderState(stored)
      } catch (err) {
        log.error(`Failed to load ${source.key}`, err)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [source])

  // A reorder synced in from another device, or made in another window.
  useEffect(() => {
    // Guarded: a host without the settings channel must leave the sidebar in
    // its default order, not tear it down.
    try {
      const unsubscribe = window.api?.onSettingsChanged?.((event) => {
        if (event.key !== source.key) return
        if (Array.isArray(event.value)) setOrderState(event.value as string[])
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } catch (err) {
      log.error(`Failed to subscribe to ${source.key} changes`, err)
      return undefined
    }
  }, [source])

  const setOrder = useCallback(
    (next: string[]): void => {
      const previous = order
      // Optimistic: the sections settle where they were dropped, not after the
      // IPC round-trip.
      setOrderState(next)
      setError(null)

      const failureMessage = getI18n().getFixedT(
        null,
        'common'
      )('phaseF.componentsAppSidebar.sectionOrderSaveFailed')

      void (async () => {
        try {
          const result = await source.save(next)
          if (!result.success) {
            setOrderState(previous)
            setError(result.error ?? failureMessage)
          }
        } catch (err) {
          setOrderState(previous)
          setError(extractErrorMessage(err, failureMessage))
        }
      })()
    },
    [order, source]
  )

  return { order, setOrder, error }
}
