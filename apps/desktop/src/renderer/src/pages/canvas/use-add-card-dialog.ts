import { useCallback, useEffect, useState, type RefObject } from 'react'
import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'
import { getCardRefs, type CardElement } from './canvas-cards'
import { onCanvasKeys } from './canvas-add-card'

/**
 * Open state of the "Add card" picker, and the entities already carded when it
 * opened. `openRef`, when given, is filled with the open function so a command
 * can reach a dialog whose button lives in the layer.
 */
export function useAddCardDialog(
  excalidrawAPI: ExcalidrawImperativeAPI,
  openRef?: RefObject<(() => void) | null>
): {
  open: boolean
  setOpen: (open: boolean) => void
  keys: ReadonlySet<string>
  openDialog: () => void
} {
  const [open, setOpen] = useState(false)
  const [keys, setKeys] = useState<ReadonlySet<string>>(() => new Set<string>())

  // Snapshot the carded entities when the picker opens. A useMemo keyed on
  // `open` would read the scene on every render and trip exhaustive-deps
  // (open is not referenced in the computation).
  const openDialog = useCallback(() => {
    setKeys(onCanvasKeys(getCardRefs(excalidrawAPI.getSceneElements() as unknown as CardElement[])))
    setOpen(true)
  }, [excalidrawAPI])

  useEffect(() => {
    if (!openRef) return
    openRef.current = openDialog
    return () => {
      openRef.current = null
    }
  }, [openRef, openDialog])

  return { open, setOpen, keys, openDialog }
}
