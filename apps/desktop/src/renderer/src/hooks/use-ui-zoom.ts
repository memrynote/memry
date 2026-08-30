import { useCallback, useEffect, useRef, useState } from 'react'
import {
  clampZoomFactor,
  DEFAULT_ZOOM_FACTOR,
  stepZoomFactor,
  type ZoomFactor
} from '@memry/contracts/ui-zoom'
import { extractErrorMessage } from '@/lib/ipc-error'
import { useT } from '@memry/i18n/renderer'
import { toast } from 'sonner'

export interface UiZoomControls {
  factor: ZoomFactor
  setFactor: (factor: number) => void
  zoomIn: () => void
  zoomOut: () => void
  resetZoom: () => void
}

/**
 * Reads and writes this install's whole-UI zoom.
 *
 * The factor is mirrored into a ref as well as state because ⌘+ repeats faster
 * than React commits: stepping from the rendered value would collapse a burst
 * of presses into a single rung.
 *
 * Safe to call from more than one component. Every instance re-syncs from the
 * main process's broadcast, which fires for the settings row, the shortcuts and
 * the menu alike.
 */
export function useUiZoom(): UiZoomControls {
  const { t } = useT('settings')
  const [factor, setFactorState] = useState<ZoomFactor>(DEFAULT_ZOOM_FACTOR)
  const factorRef = useRef<ZoomFactor>(DEFAULT_ZOOM_FACTOR)

  const adopt = useCallback((next: ZoomFactor) => {
    factorRef.current = next
    setFactorState(next)
  }, [])

  useEffect(() => {
    let cancelled = false
    void window.api.uiZoom
      .get()
      .then((current) => {
        if (!cancelled) adopt(current)
      })
      .catch(() => {
        // A failed read leaves the default in place; the app is still usable.
      })
    const unsubscribe = window.api.onUiZoomChanged(({ factor: next }) => adopt(next))
    return () => {
      cancelled = true
      unsubscribe()
    }
  }, [adopt])

  const setFactor = useCallback(
    (next: number) => {
      const applied = clampZoomFactor(next)
      adopt(applied)
      void window.api.uiZoom.set(applied).catch((err) => {
        toast.error(extractErrorMessage(err, t('appearance.display.zoom.error')))
      })
    },
    [adopt, t]
  )

  const zoomIn = useCallback(() => setFactor(stepZoomFactor(factorRef.current, 1)), [setFactor])
  const zoomOut = useCallback(() => setFactor(stepZoomFactor(factorRef.current, -1)), [setFactor])
  const resetZoom = useCallback(() => setFactor(DEFAULT_ZOOM_FACTOR), [setFactor])

  return { factor, setFactor, zoomIn, zoomOut, resetZoom }
}
