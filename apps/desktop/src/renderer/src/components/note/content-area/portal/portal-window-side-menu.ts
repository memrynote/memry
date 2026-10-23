/**
 * Lets the block side menu work inside a portal window.
 *
 * Every BlockNote side menu asks "which `.bn-editor` is closest to the mouse?"
 * over all editors in the document, and shows itself only when the answer is
 * its own editor. A portal window is an editor nested inside the host's, so the
 * host's block group contains the window's: both are at distance 0 and the
 * scan keeps the first one it saw, which is the host (the stock check is
 * `distance < min`). The window's menu therefore never appears, and the host's
 * hit-test lands on the portal block instead.
 *
 * The scan is a private arrow property of each side menu view, with no option
 * to change it. This replaces it, on the window's editor and on every editor
 * it sits in, with the same scan that lets the innermost editor win a tie.
 *
 * The menu then opens, and the host editor tears the window down under it.
 * Base UI opens a menu by marking every element outside it `data-base-ui-inert`,
 * the host's blocks included. ProseMirror reads an attribute change on a block
 * as an edit to it and marks its range dirty, and a dirty range rebuilds every
 * node view in it, the portal's and so the window and its menu. Those marks are
 * presentation, never document content, so the host and the window are told to
 * ignore them.
 *
 * @module note/content-area/portal/portal-window-side-menu
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

interface Point {
  clientX: number
  clientY: number
}

interface ClosestEditor {
  element: Element
  distance: number
}

interface SideMenuViewLike {
  findClosestEditorElement?: (coords: Point) => ClosestEditor | null
}

interface ViewWithPluginViews {
  root: Document | ShadowRoot
  pluginViews?: SideMenuViewLike[]
  /** ProseMirror's DOM observer; internal to prosemirror-view, with no hook for this. */
  domObserver?: {
    registerMutation?: (mutation: MutationRecord, added: Node[]) => unknown
  }
}

/** What Base UI sets on the elements outside an open menu. */
const PRESENTATION_ATTRIBUTES = new Set(['data-base-ui-inert', 'inert', 'aria-hidden'])

const patched = new WeakSet<object>()
const guardedObservers = new WeakSet<object>()

/**
 * Where the handle and plus sit, beside the window rather than in it: the
 * window's reach is widened by this on both sides (so RTL needs no case), or
 * the mouse would leave the window on its way to its own handle. Only beside
 * its rows: above or below the window, the host's own handles are in charge.
 */
const WINDOW_HANDLE_REACH = 64

function distanceTo(rect: DOMRect, { clientX, clientY }: Point, reach = 0): number {
  const beside = clientY >= rect.top && clientY <= rect.bottom ? reach : 0
  const left = rect.left - beside
  const right = rect.right + beside
  const dx = clientX < left ? left - clientX : Math.max(0, clientX - right)
  const dy = clientY < rect.top ? rect.top - clientY : Math.max(0, clientY - rect.bottom)
  return Math.hypot(dx, dy)
}

function innermostClosestEditor(view: ViewWithPluginViews, coords: Point): ClosestEditor | null {
  const editors = Array.from(view.root.querySelectorAll('.bn-editor'))
  let closest: ClosestEditor | null = null
  for (const element of editors) {
    const group = element.querySelector('.bn-block-group')
    if (!group) continue
    const distance = distanceTo(
      group.getBoundingClientRect(),
      coords,
      element.closest('.portal-window') ? WINDOW_HANDLE_REACH : 0
    )
    // `<=`, and document order puts a nested editor after the one around it.
    if (!closest || distance <= closest.distance) closest = { element, distance }
  }
  return closest
}

/** Patch the side menu of `view`, if it has one and is not patched yet. */
export function innermostEditorWins(view: EditorView): void {
  const withViews = view as unknown as ViewWithPluginViews
  for (const pluginView of withViews.pluginViews ?? []) {
    if (typeof pluginView.findClosestEditorElement !== 'function' || patched.has(pluginView)) {
      continue
    }
    patched.add(pluginView)
    pluginView.findClosestEditorElement = (coords) => innermostClosestEditor(withViews, coords)
  }
}

interface TiptapDom extends HTMLElement {
  editor?: { view?: EditorView }
}

function ignorePresentationMarks(view: EditorView): void {
  const observer = (view as unknown as ViewWithPluginViews).domObserver
  const register = observer?.registerMutation
  if (!observer || !register || guardedObservers.has(observer)) return
  guardedObservers.add(observer)
  observer.registerMutation = (mutation, added) =>
    mutation.type === 'attributes' && PRESENTATION_ATTRIBUTES.has(mutation.attributeName ?? '')
      ? null
      : register.call(observer, mutation, added)
}

/** `view` and every editor that holds it, outermost last. */
export function innermostEditorWinsAround(view: EditorView): void {
  innermostEditorWins(view)
  ignorePresentationMarks(view)
  for (
    let el = view.dom.parentElement?.closest<TiptapDom>('.ProseMirror');
    el;
    el = el.parentElement?.closest<TiptapDom>('.ProseMirror')
  ) {
    const outer = el.editor?.view
    if (!outer) continue
    innermostEditorWins(outer)
    ignorePresentationMarks(outer)
  }
}

/**
 * Keeps the patch on. Registering any plugin rebuilds every plugin view,
 * the side menu's included, and a fresh one has the stock scan again. A
 * plugin view is rebuilt at the same moment, so it patches once the rebuild
 * is done and again after every transaction.
 */
export function createInnermostSideMenuPlugin(): Plugin {
  return new Plugin({
    key: new PluginKey('portalSideMenuHitTest'),
    view(view) {
      queueMicrotask(() => {
        if (!view.isDestroyed) innermostEditorWinsAround(view)
      })
      return {
        update: () => innermostEditorWinsAround(view)
      }
    }
  })
}
