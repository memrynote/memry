/**
 * "Hide in this portal" for the block under the cursor, inside a portal
 * window. The window's owner registers the handler for the editor it mounts
 * (it knows the portal's definition and writes it back); the side menu and the
 * keyboard shortcut look it up by editor, like `portal-flows-api`. An editor
 * without a registered handler is not a portal window, so the item is absent.
 *
 * @module note/content-area/portal-flows/portal-hide-in-portal
 */

import type { EditorSchema } from '../editor-schema'

type Editor = EditorSchema['BlockNoteEditor']

export interface HideInPortalHandler {
  /** Whether `blockId` can be hidden here (false for the only root). */
  canHide: (blockId: string) => boolean
  /** Hide the block: `hideChild` for a child, `removeRoot` for a root. */
  hide: (blockId: string) => void
}

/** Cmd+Shift+H (Ctrl+Shift+H elsewhere): what the editor key handling binds. */
export const hideInPortalShortcut = {
  key: 'h',
  mod: true,
  shift: true,
  /** Display form for the menu item. */
  label: '⌘⇧H'
} as const

const registry = new WeakMap<Editor, HideInPortalHandler>()

/** Returns the unregister function. */
export function registerHideInPortal(editor: Editor, handler: HideInPortalHandler): () => void {
  registry.set(editor, handler)
  return () => {
    if (registry.get(editor) === handler) registry.delete(editor)
  }
}

export function getHideInPortal(editor: Editor): HideInPortalHandler | undefined {
  return registry.get(editor)
}
