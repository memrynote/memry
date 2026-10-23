/**
 * The open portal windows, by the portal INSTANCE that mounted them, so the
 * toolbar and the hidden-blocks popover read the window of the portal the user
 * is in. A block id alone is not enough: one portal block is drawn by several
 * editors at once (the host in two panes, a source tab beside its host, a portal
 * inside a portal), and each draw has its own window. A window registers its
 * ProseMirror view once its plugin is on, and drops it on unmount.
 *
 * @module note/content-area/portal/portal-window-registry
 */

import { useSyncExternalStore } from 'react'
import type { EditorView } from '@tiptap/pm/view'

export interface PortalWindowEntry {
  view: EditorView
  sourceNoteId: string
}

/** One mounted draw of a portal block: the block plus the id its render was given. */
export interface PortalInstance {
  blockId: string
  instanceId: string
}

const windows = new Map<string, PortalWindowEntry>()
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

function keyOf({ blockId, instanceId }: PortalInstance): string {
  return `${instanceId}\u0000${blockId}`
}

export function registerPortalWindow(
  instance: PortalInstance,
  entry: PortalWindowEntry
): () => void {
  const key = keyOf(instance)
  windows.set(key, entry)
  notify()
  return () => {
    if (windows.get(key) !== entry) return
    windows.delete(key)
    notify()
  }
}

export function getPortalWindow(instance: PortalInstance): PortalWindowEntry | undefined {
  return windows.get(keyOf(instance))
}

export function usePortalWindow(instance: PortalInstance): PortalWindowEntry | undefined {
  const key = keyOf(instance)
  return useSyncExternalStore(
    (onChange) => {
      listeners.add(onChange)
      return () => listeners.delete(onChange)
    },
    () => windows.get(key)
  )
}
