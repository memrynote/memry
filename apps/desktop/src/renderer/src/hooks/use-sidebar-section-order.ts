import { useCallback, useEffect, useState } from 'react'
import { getI18n } from 'react-i18next'
import { extractErrorMessage } from '@/lib/ipc-error'
import { createLogger } from '@/lib/logger'

const log = createLogger('SidebarSectionOrder')

/** Mirrors SIDEBAR_SECTION_ORDER_SETTINGS_KEY in the main process. */
const SIDEBAR_SECTION_ORDER_SETTINGS_KEY = 'sidebar.sectionOrder'

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
  const [order, setOrderState] = useState<string[]>([])
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    let mounted = true
    const load = async (): Promise<void> => {
      try {
        const stored = await window.api?.settings?.getSidebarSectionOrder?.()
        if (mounted && Array.isArray(stored)) setOrderState(stored)
      } catch (err) {
        log.error('Failed to load sidebar section order', err)
      }
    }
    void load()
    return () => {
      mounted = false
    }
  }, [])

  // A reorder synced in from another device, or made in another window.
  useEffect(() => {
    // Guarded: a host without the settings channel must leave the sidebar in
    // its default order, not tear it down.
    try {
      const unsubscribe = window.api?.onSettingsChanged?.((event) => {
        if (event.key !== SIDEBAR_SECTION_ORDER_SETTINGS_KEY) return
        if (Array.isArray(event.value)) setOrderState(event.value as string[])
      })
      return typeof unsubscribe === 'function' ? unsubscribe : undefined
    } catch (err) {
      log.error('Failed to subscribe to sidebar section order changes', err)
      return undefined
    }
  }, [])

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
          const result = await window.api.settings.setSidebarSectionOrder(next)
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
    [order]
  )

  return { order, setOrder, error }
}
