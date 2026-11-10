import type { EditorView } from '@tiptap/pm/view'

/**
 * The range the editor's right-click menu acts on. On macOS WebKit selects the word under the
 * pointer in the DOM, and ProseMirror's state keeps the caret it had: the menu takes the DOM
 * selection while the state's is empty, so Cut and Copy act on the word the user sees selected.
 */
export function editorMenuSelection(view: EditorView): {
  from: number
  to: number
  empty: boolean
} {
  const { from, to, empty } = view.state.selection
  const fromState = { from, to, empty }
  if (!empty) return fromState
  const dom = view.dom.ownerDocument.getSelection()
  if (!dom?.anchorNode || !dom.focusNode || dom.isCollapsed) return fromState
  if (!view.dom.contains(dom.anchorNode) || !view.dom.contains(dom.focusNode)) return fromState
  let anchor: number
  let head: number
  try {
    anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
    head = view.posAtDOM(dom.focusNode, dom.focusOffset)
  } catch {
    // An end in DOM with no document position (a widget): the state's caret, as before.
    return fromState
  }
  return { from: Math.min(anchor, head), to: Math.max(anchor, head), empty: anchor === head }
}
