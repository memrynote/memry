/**
 * Where the insert flows plug their UI into the portal block's chrome.
 *
 * The toolbar's hidden count and the inline "N hidden" rows own the triggers,
 * but the popover behind them belongs to the flows. They register a component
 * here; the portal renders it while a request is open. With none registered,
 * the triggers do nothing.
 *
 * @module note/content-area/portal/portal-slots
 */

import { useSyncExternalStore, type ComponentType, type ReactElement } from 'react'
import type { PortalDefinition } from '@memry/shared/portal-block'
import type { PortalEditorLike } from './portal-definition'

/** What a slot learns about the portal it is attached to. */
export interface PortalHandle {
  /** The portal block's id in the editor holding it. */
  blockId: string
  /** This draw of the block (see `PortalInstanceContext`); keys its window. */
  instanceId: string
  editor: PortalEditorLike
  definition: PortalDefinition
  /** The note the portal reads from; null for a search portal. */
  sourceNoteId: string | null
  /** The note that holds the portal block, when the editor knows it. */
  hostNoteId: string | undefined
}

/** Which hidden blocks the popover lists: the roots' neighbours, or one block's children. */
export type PortalHiddenScope = { kind: 'siblings' } | { kind: 'children'; blockId: string }

export interface PortalHiddenBlocksSlotProps {
  portal: PortalHandle
  /** What to list; null while the popover is closed. */
  scope: PortalHiddenScope | null
  /** The count or row the popover hangs from. */
  anchorEl: HTMLElement | null
  onClose: () => void
}

/** The search portal's "edit query" trigger; `portal.definition.target` is the search. */
export interface PortalSearchQuerySlotProps {
  portal: PortalHandle
  /** The trigger button; the slot decides what opening it shows. */
  children: ReactElement
}

/** A slot: `register` installs its component, the hook reads it and re-renders on change. */
function createSlot<P>(): [
  register: (component: ComponentType<P>) => () => void,
  useSlot: () => ComponentType<P> | null
] {
  let current: ComponentType<P> | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const listener of listeners) listener()
  }
  const register = (component: ComponentType<P>): (() => void) => {
    current = component
    notify()
    return () => {
      if (current !== component) return
      current = null
      notify()
    }
  }
  const useSlot = (): ComponentType<P> | null =>
    useSyncExternalStore(
      (onChange) => {
        listeners.add(onChange)
        return () => listeners.delete(onChange)
      },
      () => current
    )
  return [register, useSlot]
}

/** Register the hidden-blocks popover. Returns the unregister function. */
export const [registerPortalHiddenBlocksSlot, usePortalHiddenBlocksSlot] =
  createSlot<PortalHiddenBlocksSlotProps>()

/** Register the search portal's query popover. Returns the unregister function. */
export const [registerPortalSearchQuerySlot, usePortalSearchQuerySlot] =
  createSlot<PortalSearchQuerySlotProps>()

/** What the flows do when a portal's own states ask for something only they can open. */
export interface PortalActionHandlers {
  /** "Pick another block" on a portal whose block is gone. */
  pickAnotherBlock?: (portal: PortalHandle) => void
}

let actionHandlers: PortalActionHandlers = {}

export function registerPortalActionHandlers(handlers: PortalActionHandlers): () => void {
  actionHandlers = handlers
  return () => {
    if (actionHandlers === handlers) actionHandlers = {}
  }
}

/** Read when the action runs, not at render: handlers are not state. */
export function getPortalActionHandlers(): PortalActionHandlers {
  return actionHandlers
}
