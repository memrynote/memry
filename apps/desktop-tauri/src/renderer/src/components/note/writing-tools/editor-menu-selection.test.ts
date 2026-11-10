import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { afterEach, describe, expect, it } from 'vitest'
import { editorMenuSelection } from './editor-menu-selection'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' }
  }
})

let view: EditorView | undefined

function mount(text: string, caret: number): EditorView {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })
  const place = document.createElement('div')
  document.body.append(place)
  view = new EditorView(place, { state })
  return view
}

/** Selects text in the DOM only, as WebKit's right-click on a word does. */
function selectInDom(node: Node, start: number, end: number): void {
  const range = document.createRange()
  range.setStart(node, start)
  range.setEnd(node, end)
  const selection = document.getSelection()!
  selection.removeAllRanges()
  selection.addRange(range)
}

afterEach(() => {
  view?.destroy()
  view = undefined
  document.getSelection()?.removeAllRanges()
  document.body.replaceChildren()
})

describe('editorMenuSelection', () => {
  // Step 11 row 5: on macOS the right-click selects the misspelled word in the DOM, ProseMirror's
  // state keeps the caret, and Cut and Copy stayed gray beside the spelling fix.
  it('takes the word a right-click selected in the DOM while the state has a caret', () => {
    const editor = mount('teh word', 1)
    selectInDom(editor.dom.querySelector('p')!.firstChild!, 0, 3)

    expect(editorMenuSelection(editor)).toEqual({ from: 1, to: 4, empty: false })
  })

  it("keeps the state's selection when it has one", () => {
    const editor = mount('teh word', 1)
    editor.dispatch(editor.state.tr.setSelection(TextSelection.create(editor.state.doc, 5, 9)))
    selectInDom(editor.dom.querySelector('p')!.firstChild!, 0, 3)

    expect(editorMenuSelection(editor)).toEqual({ from: 5, to: 9, empty: false })
  })

  it('keeps the caret when the DOM selection is collapsed or outside the editor', () => {
    const editor = mount('teh word', 2)
    const outside = document.createElement('p')
    outside.textContent = 'elsewhere'
    document.body.append(outside)

    selectInDom(outside.firstChild!, 0, 4)
    expect(editorMenuSelection(editor)).toEqual({ from: 2, to: 2, empty: true })

    selectInDom(editor.dom.querySelector('p')!.firstChild!, 2, 2)
    expect(editorMenuSelection(editor)).toEqual({ from: 2, to: 2, empty: true })
  })
})
