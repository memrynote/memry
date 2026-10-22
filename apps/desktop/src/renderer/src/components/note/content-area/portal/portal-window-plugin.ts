/**
 * The window onto the source: a ProseMirror plugin that hides, by decoration,
 * every block a portal does not show. The source's Y.Doc is untouched, so a
 * hidden block is still there, still synced, and still editable from where it
 * lives.
 *
 * - Block target: everything outside the anchored block's subtree is hidden.
 *   The anchored block's ancestors keep their nested group (so the subtree
 *   stays reachable) but lose their own content.
 * - `hidden` anchors drop the block carrying that anchor and its descendants.
 *   The root of a block window is never hidden.
 *
 * A block is found by the ` ^anchor` its text ends with (`extractAnchor`), the
 * same rule `@memry/shared/portal-resolve` applies to a flat block list.
 *
 * Because hidden blocks are still in the document, two things would otherwise
 * reach them: Select All followed by a delete, and a selection that spans a
 * hidden block. Select All is narrowed to what the window shows, and
 * `filterTransaction` refuses a local edit that deletes a hidden block whole.
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
import { extractAnchor, stripAnchor } from '@memry/shared/portal-block'

export const PORTAL_HIDDEN_CLASS = 'portal-window-hidden'
export const PORTAL_ANCESTOR_CLASS = 'portal-window-ancestor'
export const PORTAL_ANCHOR_CLASS = 'portal-window-anchor'

export interface PortalWindowSpec {
  /** The anchor of the block shown, or null for the whole note. */
  anchor: string | null
  /** Anchors of blocks (and their descendants) not shown. */
  hidden: readonly string[]
}

interface Span {
  from: number
  to: number
}

export interface PortalWindowState {
  spec: PortalWindowSpec
  decorations: DecorationSet
  /** True/false for a block target; null for a whole-note target. */
  rootFound: boolean | null
  /** The anchored block's text without its anchor, for the breadcrumb. */
  rootText: string | null
  /** Spans the window does not show. */
  hiddenSpans: readonly Span[]
  /** Whole blocks a local edit may not delete: hidden ones and the root's ancestors. */
  protectedSpans: readonly Span[]
}

export const portalWindowKey = new PluginKey<PortalWindowState>('portalWindow')

const BLOCK_CONTAINER = 'blockContainer'

function containerAnchor(container: PMNode): string | null {
  const content = container.firstChild
  return content ? extractAnchor(content.textContent) : null
}

/** Position of the first block, in document order, whose text ends in `^anchor`. */
export function findPortalRoot(
  doc: PMNode,
  anchor: string
): { pos: number; end: number; text: string } | null {
  let found: { pos: number; end: number; text: string } | null = null
  doc.descendants((node, pos) => {
    if (found) return false
    if (node.type.name !== BLOCK_CONTAINER) return true
    if (containerAnchor(node) === anchor) {
      found = {
        pos,
        end: pos + node.nodeSize,
        text: stripAnchor(node.firstChild?.textContent ?? '').trim()
      }
      return false
    }
    return true
  })
  return found
}

/** The decoration for the muted ` ^anchor` at the end of a visible block's text. */
function anchorDecoration(container: PMNode, pos: number): Decoration | null {
  const content = container.firstChild
  const last = content?.lastChild
  if (!content || !last?.isText || !last.text) return null
  const anchor = extractAnchor(last.text)
  if (!anchor) return null
  const at = last.text.lastIndexOf(`^${anchor}`)
  if (at < 0) return null
  const textEnd = pos + 1 + content.nodeSize - 1
  const textStart = textEnd - last.nodeSize
  return Decoration.inline(textStart + at, textEnd, { class: PORTAL_ANCHOR_CLASS })
}

export function computePortalWindow(doc: PMNode, spec: PortalWindowSpec): PortalWindowState {
  const hiddenAnchors = new Set(spec.hidden)
  const root = spec.anchor === null ? null : findPortalRoot(doc, spec.anchor)
  const rootFound = spec.anchor === null ? null : root !== null
  const decorations: Decoration[] = []
  const hiddenSpans: Span[] = []
  const protectedSpans: Span[] = []

  const hideWhole = (node: PMNode, pos: number): void => {
    const span = { from: pos, to: pos + node.nodeSize }
    decorations.push(Decoration.node(span.from, span.to, { class: PORTAL_HIDDEN_CLASS }))
    hiddenSpans.push(span)
    protectedSpans.push(span)
  }

  const visit = (parent: PMNode, start: number, inWindow: boolean): void => {
    parent.forEach((child, offset) => {
      const pos = start + offset
      if (child.type.name !== BLOCK_CONTAINER) {
        visit(child, pos + 1, inWindow)
        return
      }
      const end = pos + child.nodeSize
      if (spec.anchor !== null && !inWindow) {
        if (!root) return hideWhole(child, pos)
        if (pos === root.pos) {
          // The root is shown even when its own anchor is listed in `hidden`.
          showBlock(child, pos)
        } else if (pos < root.pos && root.end <= end) {
          const content = child.firstChild
          if (content) {
            const span = { from: pos + 1, to: pos + 1 + content.nodeSize }
            decorations.push(Decoration.node(span.from, span.to, { class: PORTAL_HIDDEN_CLASS }))
            hiddenSpans.push(span)
          }
          decorations.push(Decoration.node(pos, end, { class: PORTAL_ANCESTOR_CLASS }))
          protectedSpans.push({ from: pos, to: end })
          visit(child, pos + 1, false)
        } else {
          hideWhole(child, pos)
        }
        return
      }
      if (hiddenAnchors.has(containerAnchor(child) ?? '')) return hideWhole(child, pos)
      showBlock(child, pos)
    })
  }

  const showBlock = (child: PMNode, pos: number): void => {
    const muted = anchorDecoration(child, pos)
    if (muted) decorations.push(muted)
    visit(child, pos + 1, true)
  }

  visit(doc, 0, false)
  return {
    spec,
    decorations: DecorationSet.create(doc, decorations),
    rootFound,
    rootText: root?.text ?? null,
    hiddenSpans,
    protectedSpans
  }
}

function sameSpec(a: PortalWindowSpec, b: PortalWindowSpec): boolean {
  return (
    a.anchor === b.anchor &&
    a.hidden.length === b.hidden.length &&
    a.hidden.every((anchor, i) => anchor === b.hidden[i])
  )
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
      apply(tr, value) {
        const next = tr.getMeta(portalWindowKey) as PortalWindowSpec | undefined
        if (next && !sameSpec(next, value.spec)) return computePortalWindow(tr.doc, next)
        if (tr.docChanged) return computePortalWindow(tr.doc, value.spec)
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
      const protectedSpans = portalWindowKey.getState(state)?.protectedSpans ?? []
      return !deletesProtectedBlock(tr, protectedSpans)
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

/** Point a mounted window at a new spec (after `hidden` changed). */
export function setPortalWindowSpec(view: EditorView, spec: PortalWindowSpec): void {
  view.dispatch(view.state.tr.setMeta(portalWindowKey, spec))
}
