import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { afterEach, describe, expect, it } from 'vitest'
import { editorMenuSelection } from './editor-menu-selection'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    text: { group: 'inline' },
    // A portal-like island: an atom whose DOM is a non-editable frame around its own text.
    portal: {
      group: 'block',
      atom: true,
      toDOM: () => ['div', { contenteditable: 'false' }, ['p', 'portal inner text']]
    },
    // A callout: a non-editable label beside the textblock's own content.
    callout: {
      group: 'block',
      content: 'inline*',
      toDOM: () => ['div', ['span', { contenteditable: 'false' }, 'Note'], ['p', 0]]
    },
    table: { group: 'block', content: 'row+', toDOM: () => ['table', ['tbody', 0]] },
    row: { content: 'cell+', toDOM: () => ['tr', 0] },
    cell: { content: 'inline*', toDOM: () => ['td', 0] }
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

function mountDoc(blocks: ReturnType<typeof schema.node>[], caret: number): EditorView {
  const doc = schema.node('doc', null, blocks)
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })
  const place = document.createElement('div')
  document.body.append(place)
  view = new EditorView(place, { state })
  return view
}

/** A DOM-only selection from anchor to focus, in either direction. */
function selectDomExtent(anchor: Node, anchorOffset: number, focus: Node, focusOffset: number) {
  document.getSelection()!.setBaseAndExtent(anchor, anchorOffset, focus, focusOffset)
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

/** "outer text" (1..11), the portal (12..13), "after" (14..19). */
function mountWithPortal(caret: number): EditorView {
  const doc = schema.node('doc', null, [
    schema.node('paragraph', null, [schema.text('outer text')]),
    schema.node('portal'),
    schema.node('paragraph', null, [schema.text('after')])
  ])
  const state = EditorState.create({ doc, selection: TextSelection.create(doc, caret) })
  const place = document.createElement('div')
  document.body.append(place)
  view = new EditorView(place, { state })
  return view
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

  // #4146: Cmd+A inside a portal's nested editor selects its whole frame in the DOM, which maps to
  // the portal node. Taking it would let Cut and Stash delete the portal block.
  it('keeps the caret when the DOM selection covers a non-editable island (Cmd+A inside it)', () => {
    const editor = mountWithPortal(3)
    const inner = editor.dom.querySelector('[contenteditable="false"] p')!
    const range = document.createRange()
    range.selectNodeContents(inner)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  // #4146: a drag inside the island maps to its boundary, so Paste would land there, not at the caret.
  it('keeps the caret when the DOM selection is a drag inside a non-editable island', () => {
    const editor = mountWithPortal(3)
    selectInDom(editor.dom.querySelector('[contenteditable="false"] p')!.firstChild!, 2, 9)

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  it('keeps the caret when one end of the DOM selection is inside the island', () => {
    const editor = mountWithPortal(3)
    const range = document.createRange()
    range.setStart(editor.dom.querySelector('p')!.firstChild!, 2)
    range.setEnd(editor.dom.querySelector('[contenteditable="false"] p')!.firstChild!, 4)
    const selection = document.getSelection()!
    selection.removeAllRanges()
    selection.addRange(range)

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  // #4146 verify: the mirror of the case above. A check of the head alone passes every other case.
  it('keeps the caret when the DOM selection starts inside the island and ends on outer text', () => {
    const editor = mountWithPortal(3)
    selectDomExtent(
      editor.dom.querySelector('[contenteditable="false"] p')!.firstChild!,
      4,
      editor.dom.querySelector('p')!.firstChild!,
      2
    )

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  // #4146 verify: a DOM range across table cells has both ends in inline content, and Cut on it
  // collapsed a BlockNote 2x2 table into one cell.
  it('keeps the caret when the DOM selection crosses table cells', () => {
    const cell = (text: string) => schema.node('cell', null, [schema.text(text)])
    const editor = mountDoc(
      [
        schema.node('paragraph', null, [schema.text('outer text')]),
        schema.node('table', null, [
          schema.node('row', null, [cell('aaa'), cell('bbb')]),
          schema.node('row', null, [cell('ccc'), cell('ddd')])
        ])
      ],
      3
    )
    const cells = editor.dom.querySelectorAll('td')
    selectDomExtent(cells[0].firstChild!, 1, cells[3].firstChild!, 2)

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  // #4146 verify: paragraph to paragraph across an image deleted the image on Cut.
  it('keeps the caret when the DOM selection spans paragraphs around an island', () => {
    const editor = mountWithPortal(3)
    const paragraphs = editor.dom.querySelectorAll(':scope > p')
    selectDomExtent(paragraphs[0].firstChild!, 6, paragraphs[1].firstChild!, 2)

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  // #4146 verify: text to a closed callout's label merged the callout into the paragraph on Cut.
  it("keeps the caret when the DOM selection ends on a callout's label", () => {
    const editor = mountDoc(
      [
        schema.node('paragraph', null, [schema.text('outer text')]),
        schema.node('callout', null, [schema.text('inside')])
      ],
      3
    )
    selectDomExtent(
      editor.dom.querySelector('p')!.firstChild!,
      6,
      editor.dom.querySelector('[contenteditable="false"]')!.firstChild!,
      2
    )

    expect(editorMenuSelection(editor)).toEqual({ from: 3, to: 3, empty: true })
  })

  it('still takes a right-clicked word beside an island', () => {
    const editor = mountWithPortal(3)
    selectInDom(editor.dom.querySelector('p')!.firstChild!, 6, 10)

    expect(editorMenuSelection(editor)).toEqual({ from: 7, to: 11, empty: false })
  })
})
