/**
 * What a gesture in a portal window does to the portal's definition.
 *
 * Each planner reads the window (`getPortalWindowState`) and the current
 * definition and returns the next definition, without touching either. A
 * fence entry needs a block's anchor, and a block has one only once it has been
 * stamped (`portals:stamp-anchor`), so a plan can come back unfinished:
 *
 *   let plan = planHide(view, def, blockId)
 *   if (plan?.stamp?.length) plan = plan.resolve(await stampAll(plan.stamp))
 *   if (plan) write(plan.definition)
 *
 * `stamp` lists the blocks that need an anchor, `resolve` plans again with the
 * anchors the caller got back (blockId -> anchor), and an unfinished plan's
 * `definition` is the unchanged input. A planner returns null when the gesture
 * changes nothing or is refused (hiding the only root).
 *
 * @module note/content-area/portal/portal-plans
 */

import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import {
  addRoot,
  expandAll,
  extractAnchor,
  hideBlock,
  hideChild,
  includeParent,
  noteCreatedChild,
  removeRoot,
  showChild,
  unhideAll,
  unhideBlock,
  type PortalDefinition
} from '@memry/shared/portal-block'
import { getPortalWindowState, type PortalWindowBlock } from './portal-window-plugin'

/** Anchors for blocks that have just been stamped, by block id. */
export type StampedAnchors = Readonly<Record<string, string>>

export interface PortalPlan {
  definition: PortalDefinition
  /** Ids of the blocks that need an anchor before `definition` is final. */
  stamp?: string[]
  /** Plan again knowing the anchors of the stamped blocks. */
  resolve(anchors: StampedAnchors): PortalPlan
}

/** The window editor reports plans through this (the boundary plugin's only output). */
export interface PortalWindowCallbacks {
  /**
   * A gesture changed the portal. `plan.definition.raw` is empty here: apply
   * `plan.definition.target` onto the live definition.
   */
  onPlan(plan: PortalPlan): void | Promise<unknown>
}

interface Anchored {
  blockId: string
  anchor: string | null
}

/** Stands in for an anchor that is not stamped yet; the result is discarded. */
const PENDING = 'pending'

function planner(
  def: PortalDefinition,
  compute: (anchorOf: (block: Anchored) => string) => PortalDefinition | null
): PortalPlan | null {
  const run = (anchors: StampedAnchors): PortalPlan | null => {
    const missing = new Set<string>()
    const anchorOf = (block: Anchored): string => {
      const anchor = block.anchor ?? anchors[block.blockId]
      if (anchor) return anchor
      missing.add(block.blockId)
      return PENDING
    }
    const next = compute(anchorOf)
    if (next === null) return null
    if (missing.size > 0) {
      return {
        definition: def,
        stamp: [...missing],
        resolve: (stamped) => run({ ...anchors, ...stamped }) ?? done(def)
      }
    }
    return done(next)
  }
  return run({})
}

function done(definition: PortalDefinition): PortalPlan {
  const plan: PortalPlan = { definition, resolve: () => plan }
  return plan
}

function isBlocksTarget(def: PortalDefinition): boolean {
  return def.target.kind === 'blocks'
}

function roots(def: PortalDefinition): readonly string[] {
  return def.target.kind === 'blocks' ? def.target.blocks : []
}

function openMode(def: PortalDefinition, parentAnchor: string): 'hide' | 'show' | null {
  return def.target.kind === 'blocks' ? (def.target.open[parentAnchor]?.mode ?? null) : null
}

function containerAnchor(container: PMNode | null | undefined): string | null {
  return container?.firstChild ? extractAnchor(container.firstChild.textContent) : null
}

/** Where a block sits in the document: its container, parent container and earlier siblings. */
function locate(doc: PMNode, blockId: string) {
  let found: { pos: number; node: PMNode } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name === 'blockContainer' && node.attrs.id === blockId) found = { pos, node }
    return !found
  })
  if (!found) return null
  const { pos, node } = found as { pos: number; node: PMNode }
  const $pos = doc.resolve(pos)
  const group = $pos.parent
  const parentContainer = $pos.depth >= 1 ? $pos.node($pos.depth - 1) : null
  const parent = parentContainer?.type.name === 'blockContainer' ? parentContainer : null
  const earlier: PMNode[] = []
  for (let i = 0; i < $pos.index(); i++) earlier.push(group.child(i))
  return { pos, node, parent, earlier }
}

/**
 * Where blocks created through the window end up decides what the fence must
 * say, so this plans from the document as it is now, after the user has had a
 * chance to Tab or Shift+Tab the new block into place.
 *
 * - a sibling after a root (same parent as the roots): listed as a root, right
 *   after the root it follows
 * - a child of a visible block: listed under it when that block is collapsed or
 *   in show-mode; nothing to write in hide-mode (already visible)
 * - anywhere else: left alone, and the window keeps showing it
 *
 * Blocks are placed in document order, so a block nested under another new one
 * sees its parent already placed. Null when nothing needs writing.
 */
export function planReconcile(
  view: EditorView,
  def: PortalDefinition,
  pendingIds: Iterable<string>
): PortalPlan | null {
  const window = getPortalWindowState(view)
  if (!window || def.target.kind !== 'blocks') return null
  const { doc } = view.state
  // Stamping an empty block under the caret rewrites the node the caret is in,
  // which loses it. Wait for text, or for the caret to leave.
  const { $head } = view.state.selection
  const holdsCaret = (node: PMNode, pos: number): boolean =>
    $head.pos > pos && $head.pos < pos + node.nodeSize && node.firstChild?.content.size === 0
  const placed = [...pendingIds]
    .map((id) => ({ id, at: locate(doc, id) }))
    .filter((entry): entry is { id: string; at: NonNullable<ReturnType<typeof locate>> } =>
      Boolean(entry.at && !holdsCaret(entry.at.node, entry.at.pos))
    )
    .sort((x, y) => x.at.pos - y.at.pos)
  if (placed.length === 0) return null

  const rootAnchors = new Set(roots(def))
  const placedIds = new Set(placed.map((entry) => entry.id))
  const rootBlock = window.visible.find(
    (b) => b.anchor && rootAnchors.has(b.anchor) && !placedIds.has(b.blockId)
  )
  const rootParent = rootBlock ? locate(doc, rootBlock.blockId)?.parent : undefined
  const rootParentId = rootBlock ? (rootParent ? String(rootParent.attrs.id) : null) : undefined

  return planner(def, (anchorOf) => {
    let next = def
    const rootIds = new Set(
      window.visible.filter((b) => rootAnchors.has(b.anchor ?? '')).map((b) => b.blockId)
    )
    const anchored = (node: PMNode): Anchored => ({
      blockId: String(node.attrs.id),
      anchor: containerAnchor(node)
    })
    for (const { id, at } of placed) {
      const created = anchored(at.node)
      const parentId = at.parent ? String(at.parent.attrs.id) : null
      const listed = created.anchor !== null && rootAnchors.has(created.anchor)
      if (listed && rootParentId !== undefined && parentId === rootParentId) continue
      if (listed && at.parent && parentId && window.visible.some((b) => b.blockId === parentId)) {
        // Listed as a root, then Tab nested it under a visible block: it is a
        // child now, and the fence must say so instead of listing it twice.
        const parent = anchored(at.parent)
        const withoutRoot = removeRoot(next, created.anchor!)
        if (!withoutRoot) continue
        next =
          parent.anchor && openMode(withoutRoot, parent.anchor) === 'hide'
            ? withoutRoot
            : noteCreatedChild(withoutRoot, anchorOf(parent), created.anchor!)
        rootIds.delete(id)
        continue
      }
      if (rootParentId !== undefined && parentId === rootParentId) {
        const previousRoot = [...at.earlier]
          .toReversed()
          .find((n) => rootIds.has(String(n.attrs.id)))
        next = addRoot(
          next,
          anchorOf(created),
          previousRoot ? anchorOf(anchored(previousRoot)) : undefined
        )
        rootIds.add(id)
      } else if (at.parent && parentId && window.visible.some((b) => b.blockId === parentId)) {
        const parent = anchored(at.parent)
        if (parent.anchor && openMode(next, parent.anchor) === 'hide') continue
        next = noteCreatedChild(next, anchorOf(parent), anchorOf(created))
      }
    }
    return next === def ? null : next
  })
}

/**
 * Backspace at the start of an empty root removes the block, so the fence must
 * stop listing it. Null when the caret is not in an empty root, or it is the
 * only one (the portal never shows nothing).
 */
export function planBackspaceAtStart(view: EditorView, def: PortalDefinition): PortalPlan | null {
  const window = getPortalWindowState(view)
  const { $head } = view.state.selection
  if (!window || !isBlocksTarget(def) || $head.depth < 2 || $head.parentOffset !== 0) return null
  const container = $head.node($head.depth - 1)
  const block = window.visible.find((b) => b.blockId === String(container.attrs.id))
  if (!block || block.text !== '' || !block.anchor || !roots(def).includes(block.anchor)) {
    return null
  }
  const next = removeRoot(def, block.anchor)
  return next ? planner(def, () => next) : null
}

/** Every anchor the fence lists: roots, show/hide ids, a note portal's hide list. */
export function listedAnchors(def: PortalDefinition): Set<string> {
  const { target } = def
  if (target.kind === 'note') return new Set(target.hide)
  if (target.kind !== 'blocks') return new Set()
  const listed = new Set(target.blocks)
  for (const entry of Object.values(target.open)) entry.ids.forEach((id) => listed.add(id))
  return listed
}

/**
 * A local edit removed the blocks carrying `gone` from the source: drop those
 * anchors from the fence so it does not keep naming blocks that no longer
 * exist. The last root stays even when gone, so the portal shows its calm
 * missing-block row instead of nothing. Null when the fence lists none of them.
 */
export function planPrune(def: PortalDefinition, gone: ReadonlySet<string>): PortalPlan | null {
  const { target } = def
  let next: PortalDefinition = def
  if (target.kind === 'note') {
    for (const anchor of target.hide) if (gone.has(anchor)) next = unhideBlock(next, anchor)
  } else if (target.kind === 'blocks') {
    for (const anchor of target.blocks) {
      if (gone.has(anchor)) next = removeRoot(next, anchor) ?? next
    }
    const live = next.target.kind === 'blocks' ? next.target : target
    const open = Object.fromEntries(
      Object.entries(live.open).map(([parent, entry]) => [
        parent,
        { ...entry, ids: entry.ids.filter((id) => !gone.has(id)) }
      ])
    )
    if (JSON.stringify(open) !== JSON.stringify(live.open)) {
      next = { ...next, target: { ...live, open } }
    }
  }
  return next === def ? null : planner(def, () => next)
}

/**
 * Whether hiding `blockId` (and its visible descendants) would leave a note
 * portal with nothing to show: a portal never shows nothing.
 */
export function hidingLeavesNothing(
  visible: readonly PortalWindowBlock[],
  blockId: string
): boolean {
  const at = visible.findIndex((b) => b.blockId === blockId)
  if (at < 0) return false
  let end = at + 1
  while (end < visible.length && visible[end].depth > visible[at].depth) end += 1
  return visible.length - (end - at) === 0
}

function visibleBlock(view: EditorView, blockId: string): PortalWindowBlock | undefined {
  return getPortalWindowState(view)?.visible.find((b) => b.blockId === blockId)
}

/** The visible block that holds `block` as a child, by nesting. */
function visibleParent(view: EditorView, block: PortalWindowBlock): PortalWindowBlock | undefined {
  const doc = view.state.doc
  const $pos = doc.resolve(block.pos)
  const parent = $pos.depth >= 1 ? $pos.node($pos.depth - 1) : null
  if (parent?.type.name !== 'blockContainer') return undefined
  return getPortalWindowState(view)?.visible.find((b) => b.blockId === String(parent.attrs.id))
}

/**
 * Hide a visible block here: drop a root, or hide a child of its parent. In a
 * whole-note portal the block joins the deny list; null when that would leave
 * no visible block.
 */
export function planHide(
  view: EditorView,
  def: PortalDefinition,
  blockId: string
): PortalPlan | null {
  const block = visibleBlock(view, blockId)
  if (block && def.target.kind === 'note') {
    if (hidingLeavesNothing(getPortalWindowState(view)?.visible ?? [], blockId)) return null
    return planner(def, (anchorOf) => hideBlock(def, anchorOf(block)))
  }
  if (!block || !isBlocksTarget(def)) return null
  if (block.anchor && roots(def).includes(block.anchor)) {
    const next = removeRoot(def, block.anchor)
    return next && next !== def ? planner(def, () => next) : null
  }
  const parent = visibleParent(view, block)
  if (!parent?.anchor) return null
  const mode = openMode(def, parent.anchor)
  if (mode === null) return null
  if (mode === 'show') {
    const own = block.anchor
    return own ? planner(def, () => hideChild(def, parent.anchor!, own)) : null
  }
  return planner(def, (anchorOf) => hideChild(def, parent.anchor!, anchorOf(block)))
}

/**
 * Show a hidden block: a hidden sibling becomes a root, a hidden child is
 * listed or unhidden. In a whole-note portal the block leaves the deny list.
 */
export function planShow(
  view: EditorView,
  def: PortalDefinition,
  blockId: string
): PortalPlan | null {
  const window = getPortalWindowState(view)
  if (window && def.target.kind === 'note') {
    const anchor = window.hiddenSiblings.find((b) => b.blockId === blockId)?.anchor
    return anchor ? planner(def, () => unhideBlock(def, anchor)) : null
  }
  if (!window || !isBlocksTarget(def)) return null
  const sibling = window.hiddenSiblings.find((b) => b.blockId === blockId)
  if (sibling) return planner(def, (anchorOf) => addRoot(def, anchorOf(sibling)))
  for (const [parentId, children] of Object.entries(window.hiddenChildren)) {
    const child = children.find((b) => b.blockId === blockId)
    const parent = window.visible.find((b) => b.blockId === parentId)
    if (child && parent) {
      return planner(def, (anchorOf) => showChild(def, anchorOf(parent), anchorOf(child)))
    }
  }
  return null
}

/** Show every child of a visible block. */
export function planExpandAll(
  view: EditorView,
  def: PortalDefinition,
  blockId: string
): PortalPlan | null {
  const block = visibleBlock(view, blockId)
  if (!block || !isBlocksTarget(def)) return null
  return planner(def, (anchorOf) => expandAll(def, anchorOf(block)))
}

/**
 * Make an ancestor of the first root the single root, keeping what was shown.
 * Each block on the way (nearest first) is included in turn, so the path from
 * the chosen ancestor down to the old roots stays visible.
 */
export function planIncludeParent(
  view: EditorView,
  def: PortalDefinition,
  ancestorBlockId: string
): PortalPlan | null {
  const window = getPortalWindowState(view)
  if (!window || !isBlocksTarget(def)) return null
  const at = window.ancestors.findIndex((b) => b.blockId === ancestorBlockId)
  if (at < 0) return null
  const path = window.ancestors.slice(at).toReversed()
  return planner(def, (anchorOf) => path.reduce((next, a) => includeParent(next, anchorOf(a)), def))
}

/**
 * "Show all" for neighbours: every hidden sibling of the roots becomes a root.
 * In a whole-note portal it clears the deny list.
 */
export function planShowAllSiblings(view: EditorView, def: PortalDefinition): PortalPlan | null {
  const window = getPortalWindowState(view)
  if (window && def.target.kind === 'note') {
    return window.hiddenSiblings.length > 0 ? planner(def, () => unhideAll(def)) : null
  }
  if (!window || !isBlocksTarget(def) || window.hiddenSiblings.length === 0) return null
  return planner(def, (anchorOf) =>
    window.hiddenSiblings.reduce((next, b) => addRoot(next, anchorOf(b)), def)
  )
}
