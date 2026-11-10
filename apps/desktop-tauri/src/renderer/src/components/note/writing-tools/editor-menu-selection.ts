import type { EditorView } from '@tiptap/pm/view'

/**
 * The range the editor's right-click menu acts on. On macOS WebKit selects the word under the
 * pointer in the DOM, and ProseMirror's state keeps the caret it had: the menu takes the DOM
 * selection while the state's is empty, so Cut and Copy act on the word the user sees selected.
 * Only a text range counts: a DOM selection inside a non-editable island (a portal's nested
 * editor) maps to the island's boundary or the whole node, and Cut would delete the block.
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
  const anchor = view.posAtDOM(dom.anchorNode, dom.anchorOffset)
  const head = view.posAtDOM(dom.focusNode, dom.focusOffset)
  const { doc } = view.state
  if (anchor === head) return fromState
  if (!doc.resolve(anchor).parent.inlineContent || !doc.resolve(head).parent.inlineContent) {
    return fromState
  }
  return { from: Math.min(anchor, head), to: Math.max(anchor, head), empty: anchor === head }
}
