/**
 * The window onto the source: a ProseMirror plugin that hides, by decoration,
 * every block a portal does not show. The source's Y.Doc is untouched, so a
 * hidden block is still there, still synced, and still editable from where it
 * lives.
 *
 * Which blocks show is decided by `resolvePortal` from
 * `@memry/shared/portal-resolve`, the rule every other implementation shares:
 * the editor's blocks are flattened into the resolver's input and the result is
 * mapped back onto positions. This file never restates the rule.
 *
 * A block that is not visible but holds a visible one (the ancestors of a root)
 * keeps its nested group, so the root stays reachable, and loses its own
 * content. Every other hidden block is hidden whole.
 *
 * Because hidden blocks are still in the document, two things would otherwise
 * reach them: Select All followed by a delete, and a selection that spans a
 * hidden block. Select All is narrowed to what the window shows, and
 * `filterTransaction` refuses a local edit that deletes a hidden block whole.
 * `portal-boundary-plugin.ts` adds the keyboard rules on top.
 *
 * @module note/content-area/portal/portal-window-plugin
 */

import { Plugin, PluginKey, TextSelection } from '@tiptap/pm/state'
import type { EditorState, Transaction } from '@tiptap/pm/state'
import { ReplaceAroundStep, ReplaceStep } from '@tiptap/pm/transform'
import type { Node as PMNode } from '@tiptap/pm/model'
import { Decoration, DecorationSet } from '@tiptap/pm/view'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from 'y-prosemirror'
import { extractAnchor, stripAnchor, type PortalTarget } from '@memry/shared/portal-block'
import { resolvePortal, type ResolverBlock } from '@memry/shared/portal-resolve'

export const PORTAL_HIDDEN_CLASS = 'portal-window-hidden'
export const PORTAL_ANCESTOR_CLASS = 'portal-window-ancestor'

/** What a window shows: the definition's target, which is never a search. */
export type PortalWindowSpec = Exclude<PortalTarget, { kind: 'search' }>

interface Span {
  from: number
  to: number
}

export interface PortalWindowBlock {
  /** BlockNote id of the block in the source note. */
  blockId: string
  anchor: string | null
  /** Text without the trailing anchor. */
  text: string
  /** Nesting in the source note: 0 for a top-level block. */
  depth: number
  /** Position of the block's `blockContainer`. */
  pos: number
}

export interface PortalWindowState {
  spec: PortalWindowSpec
  decorations: DecorationSet
  /** True/false for a blocks target; null for a whole-note target. */
  rootFound: boolean | null
  /** First visible block's text without its anchor, for the breadcrumb. */
  rootText: string | null
  /** Visible blocks, in document order. */
  visible: PortalWindowBlock[]
  /**
   * Non-visible same-parent siblings of the roots; for a note portal, its
   * outermost hidden blocks.
   */
  hiddenSiblings: PortalWindowBlock[]
  /** Non-visible children of each visible block, by that block's id. Empty for a note portal. */
  hiddenChildren: Record<string, PortalWindowBlock[]>
  /** Path from the top of the note to the first root, outermost first. */
  ancestors: PortalWindowBlock[]
  /**
   * Blocks created here that the definition does not show yet. They are shown
   * anyway (provisionally), so the caret never lands in a hidden block, until
   * the fence lists them or they leave the document.
   */
  pending: ReadonlySet<string>
  /**
   * Every block created here that is still in the document, shown by the
   * definition or not. A block can show through the definition for a moment
   * while an edit is half applied (a split moves the root's anchor onto the new
   * block), so `pending` is recomputed from this each time.
   */
  created: ReadonlySet<string>
  /** Whole blocks a local edit may not delete: hidden ones and the roots' ancestors. */
  protectedSpans: readonly Span[]
  /** Spans the window does not show. */
  hiddenSpans: readonly Span[]
}

export const portalWindowKey = new PluginKey<PortalWindowState>('portalWindow')

/** The window state behind an editor view, or undefined when no window is attached. */
export function getPortalWindowState(view: EditorView): PortalWindowState | undefined {
  return portalWindowKey.getState(view.state)
}

const BLOCK_CONTAINER = 'blockContainer'

interface FlatBlock extends ResolverBlock {
  node: PMNode
  pos: number
  parent: number
}

function blockText(container: PMNode): string {
  return container.firstChild?.textContent ?? ''
}

/** Every block of the document in order, shaped for `resolvePortal`. */
function flattenBlocks(doc: PMNode): FlatBlock[] {
  const out: FlatBlock[] = []
  const walk = (parent: PMNode, start: number, depth: number, parentIndex: number): void => {
    parent.forEach((child, offset) => {
      const pos = start + offset
      if (child.type.name === BLOCK_CONTAINER) {
        const index = out.length
        out.push({
          node: child,
          pos,
          depth,
          parent: parentIndex,
          inline: [{ text: blockText(child) }]
        })
        walk(child, pos + 1, depth + 1, index)
      } else if (!child.isTextblock) {
        walk(child, pos + 1, depth, parentIndex)
      }
    })
  }
  walk(doc, 0, 0, -1)
  return out
}

function toWindowBlock(block: FlatBlock): PortalWindowBlock {
  const text = blockText(block.node)
  return {
    blockId: String(block.node.attrs.id),
    anchor: extractAnchor(text),
    text: stripAnchor(text).trim(),
    depth: block.depth,
    pos: block.pos
  }
}

/** Position of the first block, in document order, whose text ends in `^anchor`. */
export function findPortalRoot(
  doc: PMNode,
  anchor: string
): { pos: number; end: number; text: string } | null {
  for (const block of flattenBlocks(doc)) {
    if (extractAnchor(blockText(block.node)) !== anchor) continue
    return {
      pos: block.pos,
      end: block.pos + block.node.nodeSize,
      text: stripAnchor(blockText(block.node)).trim()
    }
  }
  return null
}

export function computePortalWindow(
  doc: PMNode,
  spec: PortalWindowSpec,
  createdIds: ReadonlySet<string> = new Set()
): PortalWindowState {
  const flat = flattenBlocks(doc)
  const resolution = resolvePortal(flat, spec)
  const shown = new Set<FlatBlock>(resolution.status === 'ok' ? resolution.blocks : [])
  const created = new Set<string>()
  const pending = new Set<string>()
  for (const block of flat) {
    const id = String(block.node.attrs.id)
    if (!createdIds.has(id)) continue
    created.add(id)
    if (shown.has(block)) continue
    pending.add(id)
    shown.add(block)
  }

  // Blocks that are hidden but hold a visible block: keep the group, drop the content.
  const holdsVisible = new Set<number>()
  flat.forEach((block) => {
    if (!shown.has(block)) return
    for (let p = block.parent; p >= 0 && !holdsVisible.has(p); p = flat[p].parent) {
      holdsVisible.add(p)
    }
  })

  const decorations: Decoration[] = []
  const hiddenSpans: Span[] = []
  const protectedSpans: Span[] = []
  flat.forEach((block, i) => {
    if (shown.has(block)) return
    const end = block.pos + block.node.nodeSize
    if (!holdsVisible.has(i)) {
      // A hidden block inside a hidden block is covered by the outer one.
      if (block.parent >= 0 && !shown.has(flat[block.parent]) && !holdsVisible.has(block.parent)) {
        return
      }
      decorations.push(Decoration.node(block.pos, end, { class: PORTAL_HIDDEN_CLASS }))
      hiddenSpans.push({ from: block.pos, to: end })
      protectedSpans.push({ from: block.pos, to: end })
      return
    }
    const content = block.node.firstChild
    if (content) {
      const span = { from: block.pos + 1, to: block.pos + 1 + content.nodeSize }
      decorations.push(Decoration.node(span.from, span.to, { class: PORTAL_HIDDEN_CLASS }))
      hiddenSpans.push(span)
    }
    decorations.push(Decoration.node(block.pos, end, { class: PORTAL_ANCESTOR_CLASS }))
    protectedSpans.push({ from: block.pos, to: end })
  })

  const visible = flat.filter((block) => shown.has(block)).map(toWindowBlock)
  const byBlock = new Map(flat.map((block) => [block, toWindowBlock(block)]))
  const hiddenChildren: Record<string, PortalWindowBlock[]> = {}
  flat.forEach((block) => {
    const parent = block.parent >= 0 ? flat[block.parent] : null
    // A note portal has no folds: what it hides is listed as siblings only.
    if (spec.kind === 'note' || shown.has(block) || !parent || !shown.has(parent)) return
    ;(hiddenChildren[String(parent.node.attrs.id)] ??= []).push(byBlock.get(block)!)
  })

  const firstRoot = flat.find((block) => shown.has(block))
  const ancestors: PortalWindowBlock[] = []
  for (let p = firstRoot?.parent ?? -1; p >= 0; p = flat[p].parent) {
    ancestors.unshift(byBlock.get(flat[p])!)
  }

  return {
    spec,
    decorations: DecorationSet.create(doc, decorations),
    rootFound: spec.kind === 'note' ? null : resolution.status === 'ok',
    rootText: visible[0]?.text ?? null,
    visible,
    hiddenSiblings: resolution.hidden.siblings.map((block) => byBlock.get(block)!),
    hiddenChildren,
    ancestors,
    pending,
    created,
    protectedSpans,
    hiddenSpans
  }
}

/** Ids of every block in the document. */
export function blockIds(doc: PMNode): Set<string> {
  return new Set(flattenBlocks(doc).map((block) => String(block.node.attrs.id)))
}

/** The id of the block holding the selection head, if any. */
function caretBlockId(state: EditorState): string | null {
  const { $head } = state.selection
  for (let d = $head.depth; d >= 0; d--) {
    const node = $head.node(d)
    if (node.type.name === BLOCK_CONTAINER) return String(node.attrs.id)
  }
  return null
}

function sameSpec(a: PortalWindowSpec, b: PortalWindowSpec): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

/** Deleted spans of one step, in the document the step applies to. */
function deletedSpans(step: unknown): Span[] {
  if (step instanceof ReplaceStep)
    return step.to > step.from ? [{ from: step.from, to: step.to }] : []
  if (step instanceof ReplaceAroundStep) {
    const spans: Span[] = []
    if (step.gapFrom > step.from) spans.push({ from: step.from, to: step.gapFrom })
    if (step.to > step.gapTo) spans.push({ from: step.gapTo, to: step.to })
    return spans
  }
  return []
}

/** True when a local transaction deletes a whole block the window protects. */
export function deletesProtectedBlock(tr: Transaction, protectedSpans: readonly Span[]): boolean {
  let spans = protectedSpans
  for (const step of tr.steps) {
    const deleted = deletedSpans(step)
    if (deleted.some((d) => spans.some((p) => d.from <= p.from && d.to >= p.to))) return true
    const map = step.getMap()
    spans = spans.map((p) => ({ from: map.map(p.from, 1), to: map.map(p.to, -1) }))
  }
  return false
}

/** True when a local transaction deletes across the edge of a hidden span: a join with hidden content. */
export function cutsHiddenSpan(tr: Transaction, hiddenSpans: readonly Span[]): boolean {
  let spans = hiddenSpans
  for (let i = 0; i < tr.steps.length; i += 1) {
    const step = tr.steps[i]
    // Sinking or lifting a block re-seats closing tokens next to hidden blocks
    // without taking any of their text: that is not a join.
    const moveOnly = step instanceof ReplaceAroundStep
    const deleted = deletedSpans(step).filter(
      (d) => !moveOnly || tr.docs[i].textBetween(d.from, d.to, '\n', '\n') !== ''
    )
    const cuts = deleted.some((d) =>
      spans.some((h) => d.from < h.to && d.to > h.from && !(d.from >= h.from && d.to <= h.to))
    )
    if (cuts) return true
    const map = step.getMap()
    spans = spans.map((h) => ({ from: map.map(h.from, 1), to: map.map(h.to, -1) }))
  }
  return false
}

function parentIds(doc: PMNode): Map<string, string | null> {
  const flat = flattenBlocks(doc)
  return new Map(
    flat.map((b) => [
      String(b.node.attrs.id),
      b.parent >= 0 ? String(flat[b.parent].node.attrs.id) : null
    ])
  )
}

/**
 * True when a local transaction moves a visible block under a parent the
 * window does not show (or to the top of the note): lifting a root out of its
 * ancestors, or a child out of the root, would make it vanish from the window.
 */
export function movesVisibleBlockOut(
  before: PMNode,
  after: PMNode,
  visible: readonly PortalWindowBlock[]
): boolean {
  const shown = new Set(visible.map((b) => b.blockId))
  const was = parentIds(before)
  const now = parentIds(after)
  return visible.some((b) => {
    if (!now.has(b.blockId)) return false
    const parent = now.get(b.blockId) ?? null
    return parent !== (was.get(b.blockId) ?? null) && (parent === null || !shown.has(parent))
  })
}

/** Select All, narrowed to the textblocks the window shows. */
function selectVisible(state: EditorState, hidden: readonly Span[]): TextSelection | null {
  let first: number | null = null
  let last: number | null = null
  state.doc.descendants((node, pos) => {
    if (hidden.some((s) => pos >= s.from && pos < s.to)) return false
    if (!node.isTextblock) return true
    first ??= pos + 1
    last = pos + node.nodeSize - 1
    return false
  })
  if (first === null || last === null) return null
  return TextSelection.create(state.doc, first, last)
}

export function createPortalWindowPlugin(
  initial: PortalWindowSpec,
  onResolve?: (resolved: { rootFound: boolean | null; rootText: string | null }) => void
): Plugin<PortalWindowState> {
  return new Plugin<PortalWindowState>({
    key: portalWindowKey,
    state: {
      init: (_config, state) => computePortalWindow(state.doc, initial),
      apply(tr, value, oldState) {
        const next = tr.getMeta(portalWindowKey) as PortalWindowSpec | undefined
        let created = value.created
        // A block a local edit creates from inside the window is pending: the
        // fence does not list it yet, and it must stay visible meanwhile.
        if (tr.docChanged && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin) {
          const caret = caretBlockId(oldState)
          if (caret && value.visible.some((b) => b.blockId === caret)) {
            const before = blockIds(oldState.doc)
            const added = [...blockIds(tr.doc)].filter((id) => !before.has(id))
            if (added.length > 0) created = new Set([...created, ...added])
          }
        }
        if (next && !sameSpec(next, value.spec)) {
          // A new definition settles what the old one did not show: those
          // blocks are the ones it was written for.
          const kept = new Set([...created].filter((id) => value.pending.has(id)))
          return computePortalWindow(tr.doc, next, kept)
        }
        if (tr.docChanged || created !== value.created) {
          return computePortalWindow(tr.doc, value.spec, created)
        }
        return value
      }
    },
    props: {
      decorations: (state) => portalWindowKey.getState(state)?.decorations ?? null,
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        if (event.key.toLowerCase() !== 'a' || !(event.metaKey || event.ctrlKey)) return false
        if (event.shiftKey || event.altKey) return false
        const hidden = portalWindowKey.getState(view.state)?.hiddenSpans ?? []
        const selection = selectVisible(view.state, hidden)
        if (!selection) return false
        view.dispatch(view.state.tr.setSelection(selection))
        return true
      }
    },
    filterTransaction(tr, state) {
      if (!tr.docChanged) return true
      // Remote updates merge in as-is: this window only guards its own edits.
      if (tr.getMeta(ySyncPluginKey)?.isChangeOrigin) return true
      const window = portalWindowKey.getState(state)
      if (!window) return true
      return !(
        deletesProtectedBlock(tr, window.protectedSpans) ||
        cutsHiddenSpan(tr, window.hiddenSpans) ||
        movesVisibleBlockOut(state.doc, tr.doc, window.visible)
      )
    },
    view(view) {
      let reported: PortalWindowState | undefined
      const report = (): void => {
        const state = portalWindowKey.getState(view.state)
        if (!state) return
        if (reported?.rootFound === state.rootFound && reported.rootText === state.rootText) return
        reported = state
        onResolve?.({ rootFound: state.rootFound, rootText: state.rootText })
      }
      report()
      return { update: report }
    }
  })
}

/** Point a mounted window at a new target (after the definition changed). */
export function setPortalWindowSpec(view: EditorView, spec: PortalWindowSpec): void {
  view.dispatch(view.state.tr.setMeta(portalWindowKey, spec))
}
