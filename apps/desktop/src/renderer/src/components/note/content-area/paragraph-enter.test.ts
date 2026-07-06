import { describe, expect, it } from 'vitest'
import { Schema, type Node as PMNode } from 'prosemirror-model'
import { EditorState, TextSelection, type Transaction } from 'prosemirror-state'
import { insertParagraphLineBreak } from './paragraph-enter'

// Minimal schema mirroring the BlockNote nodes the command inspects.
const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*' },
    heading: { group: 'block', content: 'inline*' },
    text: { group: 'inline' },
    hardBreak: { group: 'inline', inline: true, selectable: false }
  }
})

const br = schema.nodes.hardBreak.create()

function stateWith(doc: PMNode, cursorAt: number): EditorState {
  const state = EditorState.create({ schema, doc })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursorAt)))
}

function run(state: EditorState): { handled: boolean; tr: Transaction | null } {
  let tr: Transaction | null = null
  const handled = insertParagraphLineBreak(state, (t) => {
    tr = t
  })
  return { handled, tr }
}

describe('insertParagraphLineBreak', () => {
  it('inserts a hard break mid-paragraph and reports handled', () => {
    // doc: <p>kaan|uraz</p>  (cursor after "kaan")
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('kaanuraz')])
    ])
    const { handled, tr } = run(stateWith(doc, 5)) // after "kaan"

    expect(handled).toBe(true)
    expect(tr).not.toBeNull()
    const para = tr!.doc.firstChild!
    // A hardBreak node now sits between the two text runs.
    expect(para.content.childCount).toBe(3)
    expect(para.content.child(1).type.name).toBe('hardBreak')
  })

  it('on an empty trailing line, removes the dangling break and defers the split', () => {
    // doc: <p>kaan<br>|</p>  (cursor right after the break)
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('kaan'), br])
    ])
    const cursor = 1 + 4 + 1 // into paragraph + "kaan" + break
    const { handled, tr } = run(stateWith(doc, cursor))

    expect(handled).toBe(false) // let BlockNote perform the block split
    expect(tr).not.toBeNull() // but we still trimmed the trailing break
    const para = tr!.doc.firstChild!
    expect(para.textContent).toBe('kaan')
    expect(para.content.childCount).toBe(1)
  })

  it('does nothing in an empty paragraph (new block via default)', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph')])
    const { handled, tr } = run(stateWith(doc, 1))
    expect(handled).toBe(false)
    expect(tr).toBeNull()
  })

  it('ignores non-paragraph blocks (e.g. heading)', () => {
    const doc = schema.node('doc', null, [schema.node('heading', null, [schema.text('Title')])])
    const { handled, tr } = run(stateWith(doc, 3))
    expect(handled).toBe(false)
    expect(tr).toBeNull()
  })

  it('ignores a non-empty selection', () => {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('kaan')])])
    const state = EditorState.create({ schema, doc })
    const withRange = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)))
    const { handled, tr } = run(withRange)
    expect(handled).toBe(false)
    expect(tr).toBeNull()
  })
})
