import type { ExcalidrawImperativeAPI } from '@excalidraw/excalidraw/types'

/** A scene element as this file reads it: cards carry `customData`. */
interface LinkableElement {
  id: string
  customData?: { entityType?: string } | null
}

export type LinkTarget =
  | { kind: 'shape'; elementId: string }
  /** Nothing selected, several selected, or the selection is gone from the scene. */
  | { kind: 'none' }
  /** A Memry card already opens its own entity. */
  | { kind: 'card' }

/**
 * The shape the "Link to item" picker would attach to.
 *
 * Exactly one shape must be selected: a link lives on a single element, and
 * silently picking one out of several would attach it somewhere the user did
 * not look. Memry cards are excluded: a second, possibly different, link on
 * one is a contradiction.
 */
export function resolveLinkTarget(api: ExcalidrawImperativeAPI): LinkTarget {
  const selectedIds = Object.entries(api.getAppState().selectedElementIds)
    .filter(([, selected]) => selected)
    .map(([id]) => id)
  if (selectedIds.length !== 1) return { kind: 'none' }

  const element = api.getSceneElements().find((el) => el.id === selectedIds[0]) as
    | LinkableElement
    | undefined
  if (!element) return { kind: 'none' }
  if (element.customData?.entityType) return { kind: 'card' }
  return { kind: 'shape', elementId: element.id }
}
