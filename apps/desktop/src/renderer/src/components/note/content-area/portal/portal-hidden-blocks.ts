/**
 * Choosing which blocks of a portal's source stay out of view.
 *
 * `hidden` stores anchors, so hiding a block that has none first asks main to
 * stamp one on the source (`portals:stamp-anchor`), then records it.
 *
 * @module note/content-area/portal/portal-hidden-blocks
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import { extractAnchor, stripAnchor } from '@memry/shared/portal-block'
import { createLogger } from '@/lib/logger'
import { stampPortalAnchor } from './portal-api'
import { updatePortalDefinition, type PortalEditorLike } from './portal-definition'
import { findPortalRoot } from './portal-window-plugin'
import type { PortalWindowSpec } from './portal-window-plugin'
import { getPortalWindow } from './portal-window-registry'

const log = createLogger('PortalHiddenBlocks')

/** One block under the window's root (or anywhere in a whole-note window). */
export interface PortalWindowBlock {
  /** The block's BlockNote id in the source note. */
  id: string
  /** Its text without the trailing anchor. */
  text: string
  /** Nesting below the root: 0 for the root's direct children. */
  depth: number
  anchor: string | null
  /** This block is listed in `hidden`. */
  hidden: boolean
  /** A block above it is hidden, so it is out of view whatever its own state. */
  hiddenByAncestor: boolean
}

/**
 * The blocks a window can hide, in document order. The root of a block window
 * is not listed: it cannot be hidden. Neither is a block without text.
 */
export function listPortalWindowBlocks(doc: PMNode, spec: PortalWindowSpec): PortalWindowBlock[] {
  const hiddenAnchors = new Set(spec.hidden)
  const out: PortalWindowBlock[] = []

  const walk = (parent: PMNode, start: number, depth: number, hiddenAbove: boolean): void => {
    parent.forEach((child, offset) => {
      if (child.type.name !== 'blockContainer') {
        walk(child, start + offset + 1, depth, hiddenAbove)
        return
      }
      const text = child.firstChild?.textContent ?? ''
      const anchor = extractAnchor(text)
      const hidden = anchor !== null && hiddenAnchors.has(anchor)
      const label = stripAnchor(text).trim()
      // A block with no text (an empty paragraph, a file, an image) has nothing
      // to name it by and nowhere to carry an anchor, so it cannot be hidden on
      // its own and is not listed. What is nested under it still is.
      if (label !== '') {
        out.push({
          id: String(child.attrs.id),
          text: label,
          depth,
          anchor,
          hidden,
          hiddenByAncestor: hiddenAbove
        })
      }
      walk(child, start + offset + 1, label === '' ? depth : depth + 1, hiddenAbove || hidden)
    })
  }

  if (spec.anchor === null) {
    walk(doc, 0, 0, false)
    return out
  }
  const root = findPortalRoot(doc, spec.anchor)
  if (!root) return out
  const rootNode = doc.nodeAt(root.pos)
  if (rootNode) walk(rootNode, root.pos + 1, 0, false)
  return out
}

/** The blocks of the open window behind `portalBlockId`, or null when it is not mounted. */
export function readPortalWindowBlocks(
  portalBlockId: string,
  spec: PortalWindowSpec
): PortalWindowBlock[] | null {
  const entry = getPortalWindow(portalBlockId)
  return entry ? listPortalWindowBlocks(entry.view.state.doc, spec) : null
}

export interface TogglePortalHiddenInput {
  /** The editor holding the portal block, and the block. */
  editor: PortalEditorLike
  portalBlockId: string
  /** The note the portal reads from. */
  sourceNoteId: string
  block: Pick<PortalWindowBlock, 'id' | 'anchor' | 'hidden'>
}

/**
 * Hide the block, or show it again. Returns false when it could not be done:
 * the source refused to stamp an anchor (locked, gone) or the portal cannot be
 * edited.
 */
export async function togglePortalBlockHidden(input: TogglePortalHiddenInput): Promise<boolean> {
  const { editor, portalBlockId, sourceNoteId, block } = input
  if (block.hidden && block.anchor) {
    const anchor = block.anchor
    return updatePortalDefinition(editor, portalBlockId, (current) => ({
      hidden: current.hidden.filter((entry) => entry !== anchor)
    }))
  }

  let anchor = block.anchor
  if (!anchor) {
    try {
      const stamped = await stampPortalAnchor(sourceNoteId, block.id)
      if (!stamped.success) {
        log.warn('Source refused the anchor', { sourceNoteId, reason: stamped.reason })
        return false
      }
      anchor = stamped.anchor
    } catch (err) {
      log.error('Failed to stamp an anchor', { sourceNoteId, error: err })
      return false
    }
  }
  const stamp = anchor
  return updatePortalDefinition(editor, portalBlockId, (current) => ({
    hidden: current.hidden.includes(stamp) ? current.hidden : [...current.hidden, stamp]
  }))
}
