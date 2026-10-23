/**
 * Undo for what the portal's own controls write.
 *
 * The window is an editor on the SOURCE note's Y.Doc, with its own undo
 * history; a fence edit (path crumb, Show all, hide, fold) is a change to the
 * HOST note's doc, which only the host's history holds. With the caret in the
 * window, Cmd+Z reached the window's history and did nothing. After such an
 * edit the window therefore hands the next Cmd+Z to the host's undo, and the
 * Cmd+Shift+Z after that to its redo. Typing in the window ends the hand-off,
 * so Cmd+Z while typing there still undoes that typing.
 *
 * @module note/content-area/portal/portal-undo-route
 */

import { Plugin, PluginKey } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { ySyncPluginKey } from 'y-prosemirror'

/** The host editor's history, as BlockNote exposes it. */
export interface UndoableEditor {
  undo: () => unknown
  redo: () => unknown
}

interface Route {
  host: UndoableEditor
  /** Which host history step the next shortcut takes. */
  next: 'undo' | 'redo'
}

const routeKey = new PluginKey<Route | null>('portalUndoRoute')

function isUndoable(editor: unknown): editor is UndoableEditor {
  const candidate = editor as Partial<UndoableEditor> | null
  return typeof candidate?.undo === 'function' && typeof candidate.redo === 'function'
}

/** The window's fence edit just landed in `host`: its undo is next. */
export function routeUndoToHost(window: EditorView, host: unknown): void {
  if (window.isDestroyed || !isUndoable(host)) return
  window.dispatch(window.state.tr.setMeta(routeKey, { host, next: 'undo' } satisfies Route))
}

export function createPortalUndoRoutePlugin(): Plugin<Route | null> {
  const advance = (view: EditorView, route: Route, next: Route['next'] | null): void => {
    view.dispatch(view.state.tr.setMeta(routeKey, next ? { ...route, next } : null))
  }
  return new Plugin<Route | null>({
    key: routeKey,
    state: {
      init: () => null,
      apply(tr, value) {
        const meta = tr.getMeta(routeKey) as Route | null | undefined
        if (meta !== undefined) return meta
        // A local edit in the window is the user's own history again.
        if (tr.docChanged && !tr.getMeta(ySyncPluginKey)?.isChangeOrigin) return null
        return value
      }
    },
    props: {
      handleKeyDown(view, event) {
        const route = routeKey.getState(view.state)
        if (!route || !(event.metaKey || event.ctrlKey) || event.altKey) return false
        const key = event.key.toLowerCase()
        if (key === 'z' && !event.shiftKey) {
          if (route.next !== 'undo') {
            advance(view, route, null)
            return false
          }
          event.preventDefault()
          route.host.undo()
          advance(view, route, 'redo')
          return true
        }
        const redo = (key === 'z' && event.shiftKey) || (key === 'y' && !event.shiftKey)
        if (!redo || route.next !== 'redo') return false
        event.preventDefault()
        route.host.redo()
        advance(view, route, 'undo')
        return true
      }
    }
  })
}
