/**
 * The open window behind a portal block: its editor view, the window plugin's
 * state (re-read after every edit), and the inline marks the portal adds to it.
 *
 * @module note/content-area/portal/use-portal-window-view
 */

import { useCallback, useEffect, useSyncExternalStore, type RefObject } from 'react'
import { registerEditorPlugin } from '../register-editor-plugin'
import {
  createPortalInlinePlugin,
  onPortalWindowUpdate,
  type PortalInlineHandlers
} from './portal-inline-plugin'
import { getPortalWindowState, type PortalWindowState } from './portal-window-plugin'
import { usePortalWindow, type PortalInstance } from './portal-window-registry'

export function usePortalWindowState(instance: PortalInstance): PortalWindowState | undefined {
  const view = usePortalWindow(instance)?.view
  const subscribe = useCallback(
    (onChange: () => void) => (view ? onPortalWindowUpdate(view, onChange) : () => {}),
    [view]
  )
  return useSyncExternalStore(subscribe, () =>
    view && !view.isDestroyed ? getPortalWindowState(view) : undefined
  )
}

/** Put the fold chevrons and hidden-count rows on the window of one portal instance. */
export function usePortalInlineMarks(
  instance: PortalInstance,
  handlers: RefObject<PortalInlineHandlers | null>
): void {
  const view = usePortalWindow(instance)?.view
  useEffect(() => {
    if (!view || view.isDestroyed) return
    const tiptap = (view.dom as HTMLElement & { editor?: unknown }).editor
    if (!tiptap) return
    const plugin = createPortalInlinePlugin(handlers)
    return registerEditorPlugin({ _tiptapEditor: tiptap }, plugin)
  }, [view, handlers])
}
