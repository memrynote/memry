/**
 * Arrow keys into a view block (#2488).
 *
 * A view block is a `memry-view` code block whose text (the definition) is
 * hidden until the caret is inside it. At the edge of a textblock ProseMirror
 * hands an arrow key to the browser, and the browser cannot put a caret into a
 * `display: none` element, so the key did nothing: the block was unreachable
 * from the keyboard. This plugin makes that one move itself; the block then
 * sees the caret and shows its definition. Every other arrow key, including
 * every move inside or out of the block, stays native.
 */

import { Plugin, PluginKey, Selection, TextSelection } from '@tiptap/pm/state'
import type { EditorState } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'
import { VIEW_BLOCK_LANGUAGE } from '@memry/shared/view-block'

export const viewBlockKeysPluginKey = new PluginKey('viewBlockKeys')

const DIRECTIONS: Readonly<
  Record<string, { dir: 1 | -1; edge: 'up' | 'down' | 'left' | 'right' }>
> = {
  ArrowDown: { dir: 1, edge: 'down' },
  ArrowRight: { dir: 1, edge: 'right' },
  ArrowUp: { dir: -1, edge: 'up' },
  ArrowLeft: { dir: -1, edge: 'left' }
}

/**
 * The selection just past the caret's textblock in `dir`, when that is inside
 * a view block: at the definition's start going forward, at its end going
 * back. Null for anything else, which leaves the key to the browser.
 */
export function viewBlockEntry(state: EditorState, dir: 1 | -1): TextSelection | null {
  const { $head } = state.selection
  if (!$head.parent.isTextblock || $head.depth === 0) return null
  const $outside = state.doc.resolve(dir > 0 ? $head.after() : $head.before())
  const next = Selection.findFrom($outside, dir, true)
  if (!(next instanceof TextSelection)) return null
  const target = next.$head.parent
  if (target.type.name !== 'codeBlock' || target.attrs.language !== VIEW_BLOCK_LANGUAGE) {
    return null
  }
  const pos = dir > 0 ? next.$head.start() : next.$head.end()
  return TextSelection.create(state.doc, pos)
}

export function createViewBlockKeysPlugin(): Plugin {
  return new Plugin({
    key: viewBlockKeysPluginKey,
    props: {
      handleKeyDown(view: EditorView, event: KeyboardEvent) {
        const move = DIRECTIONS[event.key]
        if (!move || event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) {
          return false
        }
        if (!view.state.selection.empty || !view.endOfTextblock(move.edge)) return false
        const entry = viewBlockEntry(view.state, move.dir)
        if (!entry) return false
        view.dispatch(view.state.tr.setSelection(entry).scrollIntoView())
        return true
      }
    }
  })
}
