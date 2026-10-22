/**
 * The open portal windows, by the id of the portal block that mounted them, so
 * the hidden-blocks popover can read the blocks a window holds. A window
 * registers its ProseMirror view once its plugin is on, and drops it on unmount.
 *
 * @module note/content-area/portal/portal-window-registry
 */

import { useSyncExternalStore } from 'react'
import type { EditorView } from '@tiptap/pm/view'

export interface PortalWindowEntry {
  view: EditorView
  sourceNoteId: string
}

const windows = new Map<string, PortalWindowEntry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

export function registerPortalWindow(portalBlockId: string, entry: PortalWindowEntry): () => void {
  windows.set(portalBlockId, entry)
  notify()
  return () => {
    if (windows.get(portalBlockId) !== entry) return
    windows.delete(portalBlockId)
    notify()
  }
}

export function getPortalWindow(portalBlockId: string): PortalWindowEntry | undefined {
  return windows.get(portalBlockId)
}

export function usePortalWindow(portalBlockId: string): PortalWindowEntry | undefined {
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => windows.get(portalBlockId)
  )
}
