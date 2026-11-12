/**
 * Dragging a block handle out of a portal window moves the portal, not the
 * source block.
 *
 * The window is an editor on the SOURCE note. BlockNote treats a handle drag
 * that ends in another editor as a move between editors: the drop editor
 * inserts a copy and the origin editor deletes its selection. Out of a window
 * that deleted the block from the source note and pasted it, anchor and all,
 * into the host, so every portal onto it broke.
 *
 * A drop into the window's own editor stays BlockNote's (reordering the
 * source). A drop BlockNote would hand to any other editor is claimed before
 * BlockNote's document listeners see it, and once the drag has ended the host
 * moves its portal block to that point. The move waits for `dragend` because
 * moving the portal rebuilds the window, handle included, and a removed handle
 * never delivers the `dragend` BlockNote clears its drag state on.
 *
 * Option-drops pass through: `use-portal-block-drop` claims those.
 *
 * @module note/content-area/portal/portal-window-drag-out
 */

import { Fragment, Slice } from '@tiptap/pm/model'
import { dropPoint } from '@tiptap/pm/transform'
import type { EditorView } from '@tiptap/pm/view'
import { closestEditorAt } from './portal-window-side-menu'

/** BlockNote's `DISTANCE_TO_CONSIDER_EDITOR_BOUNDS`: farther than this, no editor takes the drop. */
const EDITOR_DROP_REACH = 250

export interface PortalDropOutside {
  /** The `.bn-editor` the drop landed in. */
  editorElement: Element
  clientX: number
  clientY: number
}

/** Watch drags that start on a handle of the window in `frame`. Returns the cleanup. */
export function attachPortalWindowDragOut(
  frame: HTMLElement,
  onDropOutside: (drop: PortalDropOutside) => void
): () => void {
  let dragging = false
  let pending: PortalDropOutside | null = null

  const onDragStart = (event: DragEvent): void => {
    const target = event.target
    dragging =
      target instanceof Element &&
      target.closest('.bn-side-menu') !== null &&
      target.closest('.portal-window') === frame
    pending = null
  }

  const onDrop = (event: DragEvent): void => {
    if (!dragging || event.altKey) return
    const closest = closestEditorAt(frame.ownerDocument, event)
    if (!closest || closest.distance > EDITOR_DROP_REACH) return
    if (closest.element.closest('.portal-window') === frame) return
    event.preventDefault()
    event.stopImmediatePropagation()
    pending = { editorElement: closest.element, clientX: event.clientX, clientY: event.clientY }
  }

  const onDragEnd = (): void => {
    const drop = pending
    dragging = false
    pending = null
    // After BlockNote's own dragend handlers have cleared its drag state.
    if (drop) setTimeout(() => onDropOutside(drop), 0)
  }

  const win = frame.ownerDocument.defaultView
  // Capture on the window runs before BlockNote's capture listeners on the document.
  win?.addEventListener('dragstart', onDragStart, true)
  win?.addEventListener('drop', onDrop, true)
  win?.addEventListener('dragend', onDragEnd, true)
  return () => {
    win?.removeEventListener('dragstart', onDragStart, true)
    win?.removeEventListener('drop', onDrop, true)
    win?.removeEventListener('dragend', onDragEnd, true)
  }
}

const clamp = (value: number, min: number, max: number): number =>
  Math.min(Math.max(value, min), max)

/**
 * Move the block `blockId` to where a drop at `drop` would land, the way
 * ProseMirror places a dropped block. False when it would not move.
 */
export function moveBlockToDrop(
  view: EditorView,
  blockId: string,
  drop: PortalDropOutside
): boolean {
  if (drop.editorElement !== view.dom) return false
  let from = -1
  view.state.doc.descendants((node, pos) => {
    if (from >= 0) return false
    if (node.type.name === 'blockContainer' && node.attrs.id === blockId) from = pos
    return from < 0
  })
  const node = from >= 0 ? view.state.doc.nodeAt(from) : null
  if (!node) return false

  // A drop beside the blocks is aimed at the nearest one, as BlockNote does.
  const bounds = view.dom.getBoundingClientRect()
  const hit = view.posAtCoords({
    left: clamp(drop.clientX, bounds.left, bounds.right),
    top: clamp(drop.clientY, bounds.top, bounds.bottom)
  })
  if (!hit) return false
  const slice = new Slice(Fragment.from(node), 0, 0)
  const insertAt = dropPoint(view.state.doc, hit.pos, slice) ?? hit.pos
  const to = from + node.nodeSize
  if (insertAt >= from && insertAt <= to) return false

  const tr = view.state.tr.delete(from, to)
  const at = tr.mapping.map(insertAt)
  tr.replaceRange(at, at, slice)
  view.dispatch(tr.scrollIntoView())
  return true
}
