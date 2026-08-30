import { useCallback, useEffect } from 'react'
import { useShortcutBinding } from '@/lib/shortcut-bindings'
import { isMac } from '@/lib/shortcut-registry'
import { matchesShortcut } from './use-keyboard-shortcuts-base'
import { useUiZoom } from './use-ui-zoom'

/**
 * Owns the whole-UI zoom shortcuts (⌘= / ⌘- / ⌘0 by default, rebindable from
 * Settings → Shortcuts as `view.zoomIn` / `view.zoomOut` / `view.resetZoom`).
 */
export function useUiZoomShortcuts(): void {
  const zoomInBinding = useShortcutBinding('view.zoomIn')
  const zoomOutBinding = useShortcutBinding('view.zoomOut')
  const resetZoomBinding = useShortcutBinding('view.resetZoom')
  const { zoomIn, zoomOut, resetZoom } = useUiZoom()

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // What users call "⌘+" is physically ⌘⇧= on a US layout and arrives as
      // key '+' with shiftKey set, which the bound ⌘= chord deliberately
      // rejects. Accepting '+' outright also picks up the numpad key, where no
      // shift is involved.
      const metaOrCtrl = isMac ? e.metaKey : e.ctrlKey
      if (
        matchesShortcut(e, zoomInBinding.key, zoomInBinding.modifiers) ||
        (metaOrCtrl && e.key === '+')
      ) {
        e.preventDefault()
        zoomIn()
        return
      }
      if (matchesShortcut(e, zoomOutBinding.key, zoomOutBinding.modifiers)) {
        e.preventDefault()
        zoomOut()
        return
      }
      if (matchesShortcut(e, resetZoomBinding.key, resetZoomBinding.modifiers)) {
        e.preventDefault()
        resetZoom()
      }
    },
    [zoomInBinding, zoomOutBinding, resetZoomBinding, zoomIn, zoomOut, resetZoom]
  )

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [handleKeyDown])
}
