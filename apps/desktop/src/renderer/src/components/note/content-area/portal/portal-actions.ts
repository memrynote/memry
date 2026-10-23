/**
 * What the portal's own controls do to its definition: the toolbar's path
 * crumbs, the hidden-blocks popover, the fold chevron, and "hide in this
 * portal". Each runs a planner from `portal-plans` against the open window,
 * stamps the anchors the plan asks for, and writes the fence.
 *
 * @module note/content-area/portal/portal-actions
 */

import { collapse } from '@memry/shared/portal-block'
import { createLogger } from '@/lib/logger'
import { stampPortalAnchor } from './portal-api'
import { updatePortalDefinition } from './portal-definition'
import {
  planExpandAll,
  planHide,
  planIncludeParent,
  planShow,
  planShowAllSiblings,
  type PortalPlan,
  type StampedAnchors
} from './portal-plans'
import type { PortalHandle } from './portal-slots'
import { getPortalWindowState } from './portal-window-plugin'
import { getPortalWindow } from './portal-window-registry'
import { routeUndoToHost } from './portal-undo-route'

const log = createLogger('PortalActions')

export interface CommitOptions {
  /**
   * The user asked for this edit through a control (crumb, menu, shortcut): the
   * next Cmd+Z in the window undoes it, which only the host's history can.
   * Edits the window makes by itself (placing a new block, pruning a deleted
   * one) leave the window's own history in charge, so typing there stays undoable.
   */
  routeUndo?: boolean
}

/** Stamp what the plan needs, plan again, and write the result. False when nothing was written. */
export async function commitPortalPlan(
  portal: PortalHandle,
  plan: PortalPlan | null,
  { routeUndo = false }: CommitOptions = {}
): Promise<boolean> {
  if (!plan) return false
  let next = plan
  if (next.stamp?.length) {
    const sourceNoteId = portal.sourceNoteId
    if (!sourceNoteId) return false
    const anchors: Record<string, string> = {}
    try {
      for (const blockId of next.stamp) {
        const stamped = await stampPortalAnchor(sourceNoteId, blockId)
        if (!stamped.success) {
          log.warn('Source refused the anchor', { sourceNoteId, reason: stamped.reason })
          return false
        }
        anchors[blockId] = stamped.anchor
      }
    } catch (err) {
      log.error('Failed to stamp an anchor', { sourceNoteId, error: err })
      return false
    }
    next = next.resolve(anchors as StampedAnchors)
    if (next.stamp?.length) return false
  }
  const target = next.definition.target
  const written = updatePortalDefinition(portal.editor, portal.blockId, () => ({
    ...portal.definition,
    target
  }))
  // The caret may be in the window, whose Cmd+Z knows nothing of the host's fence.
  const window = routeUndo ? getPortalWindow(portal)?.view : undefined
  if (written && window) routeUndoToHost(window, portal.editor)
  return written
}

export interface PortalActions {
  includeParent: (ancestorBlockId: string) => Promise<boolean>
  /** Hide a visible block in this portal: drop a root, or hide a child. */
  hide: (blockId: string) => Promise<boolean>
  /** Show a hidden sibling or child. */
  show: (blockId: string) => Promise<boolean>
  /** Show every child of a visible block. */
  expandAll: (blockId: string) => Promise<boolean>
  /** Fold a block's children away. */
  collapse: (blockId: string) => Promise<boolean>
  showAllSiblings: () => Promise<boolean>
}

/**
 * The actions of one portal. `portal.definition` is read when an action runs,
 * so build this from the latest handle (a ref) rather than a stale render.
 */
export function createPortalActions(read: () => PortalHandle): PortalActions {
  const run = (
    plan: (
      view: NonNullable<ReturnType<typeof getPortalWindow>>['view'],
      portal: PortalHandle
    ) => PortalPlan | null
  ): Promise<boolean> => {
    const portal = read()
    const view = getPortalWindow(portal)?.view
    if (!view || view.isDestroyed) return Promise.resolve(false)
    return commitPortalPlan(portal, plan(view, portal), { routeUndo: true })
  }
  return {
    includeParent: (id) => run((view, p) => planIncludeParent(view, p.definition, id)),
    hide: (id) => run((view, p) => planHide(view, p.definition, id)),
    show: (id) => run((view, p) => planShow(view, p.definition, id)),
    expandAll: (id) => run((view, p) => planExpandAll(view, p.definition, id)),
    collapse: (id) =>
      run((view, p) => {
        const anchor = getPortalWindowState(view)?.visible.find((b) => b.blockId === id)?.anchor
        if (!anchor) return null
        const definition = collapse(p.definition, anchor)
        const plan: PortalPlan = { definition, resolve: () => plan }
        return plan
      }),
    showAllSiblings: () => run((view, p) => planShowAllSiblings(view, p.definition))
  }
}
