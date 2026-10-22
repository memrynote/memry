/**
 * Keyboard rules at the edges of a portal window.
 *
 * The window shows part of a note, but its editor holds all of it, so ordinary
 * editing keys would reach hidden blocks or lose track of the window. This
 * plugin owns the keys at those edges. It is registered ahead of the editor's
 * own handlers.
 *
 * - A block created here (Enter, split, paste) is shown provisionally by the
 *   window plugin. Once the edits settle, `planReconcile` decides from where
 *   the block ended up what the fence must say, and reports it through `onPlan`.
 *   Typing is never held up: the block is visible the whole time.
 * - Enter on an empty last line leaves the window for the host note.
 * - Backspace at the very start of the first visible block selects the whole
 *   portal in the host. Anywhere else, a join into hidden content is refused by
 *   `portal-window-plugin`'s `filterTransaction`; so is any move that would
 *   take a visible block out of the window (Shift+Tab on a root).
 * - Arrows skip hidden blocks and, past the first or last visible block, hand
 *   the caret to the host.
 *
 * The host's `portal-keys-plugin` answers the two DOM events this plugin
 * dispatches on the window element, `memry:portal-exit` and `memry:portal-select`.
 *
 * @module note/content-area/portal/portal-boundary-plugin
 */

import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { Node as PMNode } from '@tiptap/pm/model'
import type { EditorView } from '@tiptap/pm/view'
import type { PortalDefinition } from '@memry/shared/portal-block'
import { anchorVisibleEnd } from './anchor-visibility-plugin'
import {
  planBackspaceAtStart,
  planReconcile,
  type PortalPlan,
  type PortalWindowCallbacks
} from './portal-plans'
import {
  blockIds,
  getPortalWindowState,
  type PortalWindowBlock,
  type PortalWindowState
} from './portal-window-plugin'

export const PORTAL_EXIT_EVENT = 'memry:portal-exit'
export const PORTAL_SELECT_EVENT = 'memry:portal-select'

export interface PortalExitDetail {
  direction: 'before' | 'after'
}

export const portalBoundaryKey = new PluginKey('portalBoundary')

const ARROW_EDGE: Readonly<
  Record<string, { dir: 1 | -1; edge: 'up' | 'down' | 'left' | 'right' }>
> = {
  ArrowUp: { dir: -1, edge: 'up' },
  ArrowLeft: { dir: -1, edge: 'left' },
  ArrowDown: { dir: 1, edge: 'down' },
  ArrowRight: { dir: 1, edge: 'right' }
}

function windowElement(view: EditorView): HTMLElement {
  return view.dom.closest<HTMLElement>('[data-portal-window]') ?? view.dom
}

function exitWindow(view: EditorView, direction: PortalExitDetail['direction']): void {
  windowElement(view).dispatchEvent(
    new CustomEvent<PortalExitDetail>(PORTAL_EXIT_EVENT, { bubbles: true, detail: { direction } })
  )
}

function selectPortal(view: EditorView): void {
  windowElement(view).dispatchEvent(new CustomEvent(PORTAL_SELECT_EVENT, { bubbles: true }))
}

/** The block container the caret is in, and its content node. */
function caretBlock(view: EditorView): { id: string; container: PMNode } | null {
  const { selection } = view.state
  if (!selection.empty) return null
  const { $head } = selection
  if (!$head.parent.isTextblock || $head.depth < 1) return null
  const container = $head.node($head.depth - 1)
  return container.type.name === 'blockContainer'
    ? { id: String(container.attrs.id), container }
    : null
}

function currentIndex(visible: readonly PortalWindowBlock[], id: string): number {
  return visible.findIndex((b) => b.blockId === id)
}

/**
 * Move the caret to the neighbouring visible block, or out to the host past
 * the first or last one. True when the key was handled.
 */
export function moveAcrossVisible(view: EditorView, dir: 1 | -1): boolean {
  const window = getPortalWindowState(view)
  const here = caretBlock(view)
  if (!window || !here) return false
  const at = currentIndex(window.visible, here.id)
  if (at < 0) return false
  const target = window.visible[at + dir]
  if (!target) {
    exitWindow(view, dir > 0 ? 'after' : 'before')
    return true
  }
  const { doc } = view.state
  const node = doc.nodeAt(target.pos)
  if (!node) return false
  const selection =
    dir > 0
      ? Selection.near(doc.resolve(target.pos + 1), 1)
      : Selection.near(doc.resolve(target.pos + node.nodeSize - 1), -1)
  view.dispatch(view.state.tr.setSelection(selection).scrollIntoView())
  return true
}

interface PendingRemove {
  blockId: string
  plan: PortalPlan
}

/**
 * Enter at the end of a block that has children. The editor's own split hands
 * the children to the new block, which would move blocks the window may hide.
 * Instead an empty block of the same kind goes in as the block's first child
 * when it has a visible child, and after the whole subtree when all of its
 * children are hidden: the user sees a block with no children, and Tab then
 * makes the new block its last child.
 */
function insertBelowParent(
  view: EditorView,
  container: PMNode,
  visibleIds: ReadonlySet<string>
): boolean {
  const { $head } = view.state.selection
  const content = container.firstChild
  const group = container.childCount > 1 ? container.lastChild : null
  if (!content?.isTextblock || !group) return false
  let hasVisibleChild = false
  group.forEach((child) => {
    hasVisibleChild ||= visibleIds.has(String(child.attrs.id))
  })
  const created = container.type.createAndFill(
    { id: crypto.randomUUID() },
    content.type.createAndFill()
  )
  if (!created) return false
  // `$head.after()` ends the text block, which is where the children's group begins.
  const at = hasVisibleChild ? $head.after() + 1 : $head.after($head.depth - 1)
  const tr = view.state.tr.insert(at, created)
  tr.setSelection(TextSelection.create(tr.doc, at + 2)).scrollIntoView()
  view.dispatch(tr)
  return true
}

/** Quiet time after the last edit before pending blocks are placed in the fence. */
export const RECONCILE_DELAY_MS = 150

/**
 * Blocks created here that the fence may need to place: those it does not list
 * yet, and those it lists as roots, since Tab can nest a listed root under a
 * visible block after it was placed.
 */
function reconcileCandidates(window: PortalWindowState): Set<string> {
  const ids = new Set(window.pending)
  if (window.spec.kind !== 'blocks') return ids
  const listed = new Set(window.spec.blocks)
  for (const block of window.visible) {
    if (window.created.has(block.blockId) && block.anchor && listed.has(block.anchor)) {
      ids.add(block.blockId)
    }
  }
  return ids
}

function definitionOf(view: EditorView): PortalDefinition | null {
  const window = getPortalWindowState(view)
  return window ? { v: 1, target: window.spec, raw: {} } : null
}

export function createPortalBoundaryPlugin(callbacks: PortalWindowCallbacks): Plugin {
  let pending: PendingRemove | null = null
  const expect = (next: PendingRemove): void => {
    pending = next
    // Whatever the editor did with the key, it did it synchronously.
    setTimeout(() => {
      if (pending === next) pending = null
    }, 0)
  }

  const onEnter = (view: EditorView, here: { id: string; container: PMNode }): boolean => {
    const window = getPortalWindowState(view)
    if (!window || currentIndex(window.visible, here.id) < 0) return false
    const block = window.visible[currentIndex(window.visible, here.id)]
    if (block.text === '' && block.blockId === window.visible[window.visible.length - 1].blockId) {
      // An empty line made here and never used leaves no stray block behind.
      const { $head } = view.state.selection
      if (
        window.pending.has(here.id) &&
        here.container.childCount === 1 &&
        $head.node($head.depth - 2).childCount > 1
      ) {
        const from = $head.before($head.depth - 1)
        view.dispatch(view.state.tr.delete(from, from + here.container.nodeSize))
      }
      exitWindow(view, 'after')
      return true
    }
    const { $head } = view.state.selection
    if ($head.pos === anchorVisibleEnd($head)) {
      return insertBelowParent(view, here.container, new Set(window.visible.map((b) => b.blockId)))
    }
    return false
  }

  const onBackspace = (view: EditorView, here: { id: string }): boolean => {
    const window = getPortalWindowState(view)
    if (!window || view.state.selection.$head.parentOffset !== 0) return false
    const at = currentIndex(window.visible, here.id)
    if (at < 0) return false
    if (at === 0) {
      selectPortal(view)
      return true
    }
    const def = definitionOf(view)
    const plan = def ? planBackspaceAtStart(view, def) : null
    if (plan) expect({ blockId: here.id, plan })
    return false
  }

  const onShiftTab = (view: EditorView, here: { id: string }): boolean => {
    const window = getPortalWindowState(view)
    if (!window || currentIndex(window.visible, here.id) < 0) return false
    // blockContainer > blockGroup > textblock's container: two levels up is the parent block.
    const { $head } = view.state.selection
    const parent = $head.depth >= 3 ? $head.node($head.depth - 3) : null
    const parentId = parent?.type.name === 'blockContainer' ? String(parent.attrs.id) : null
    // A block whose parent is not shown sits at the window's top level: nowhere to lift to.
    return !window.visible.some((b) => b.blockId === parentId)
  }

  /** Tab with no previous sibling to nest under does nothing; it must not move focus out of the window. */
  const onTab = (view: EditorView): boolean => {
    const { $head } = view.state.selection
    return $head.depth >= 2 && $head.index($head.depth - 2) === 0
  }

  return new Plugin({
    key: portalBoundaryKey,
    props: {
      handleKeyDown(view, event) {
        if (event.metaKey || event.ctrlKey || event.altKey) return false
        const here = caretBlock(view)
        if (!here) return false
        if (event.key === 'Enter' && !event.shiftKey) return onEnter(view, here)
        if (event.key === 'Backspace' && !event.shiftKey) return onBackspace(view, here)
        if (event.key === 'Tab' && event.shiftKey) return onShiftTab(view, here)
        if (event.key === 'Tab') return onTab(view)
        const arrow = ARROW_EDGE[event.key]
        if (!arrow || event.shiftKey) return false
        return view.endOfTextblock(arrow.edge) ? moveAcrossVisible(view, arrow.dir) : false
      }
    },
    view() {
      let timer: ReturnType<typeof setTimeout> | undefined
      let busy = false
      let dirty = false
      const reconcile = (view: EditorView): void => {
        timer = undefined
        if (view.isDestroyed) return
        if (busy) {
          dirty = true
          return
        }
        const window = getPortalWindowState(view)
        if (!window) return
        const ids = reconcileCandidates(window)
        if (ids.size === 0) return
        const plan = planReconcile(view, { v: 1, target: window.spec, raw: {} }, ids)
        if (!plan) return
        busy = true
        void Promise.resolve(callbacks.onPlan(plan)).finally(() => {
          busy = false
          if (!dirty) return
          dirty = false
          schedule(view)
        })
      }
      const schedule = (view: EditorView): void => {
        clearTimeout(timer)
        timer = setTimeout(() => reconcile(view), RECONCILE_DELAY_MS)
      }
      return {
        update(view, previous) {
          if (view.state.doc === previous.doc) return
          if (pending) {
            const done = pending
            pending = null
            if (!blockIds(view.state.doc).has(done.blockId)) void callbacks.onPlan(done.plan)
          }
          const window = getPortalWindowState(view)
          if (window && reconcileCandidates(window).size > 0) schedule(view)
        },
        destroy() {
          clearTimeout(timer)
        }
      }
    }
  })
}
