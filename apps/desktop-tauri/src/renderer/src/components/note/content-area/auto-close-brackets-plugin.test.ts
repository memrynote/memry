/**
 * Typing through a real ProseMirror view, the way `view.input` does it: the
 * plugins' `handleTextInput` props get the first look, and only a refusal falls
 * through to a plain insert. A stand-in for BlockNote's suggestion menu sits in
 * front, claiming the second `[` the way the real one does, so the `[[` case
 * runs against the ordering that ships.
 */

import { Schema } from '@tiptap/pm/model'
import { EditorState, Plugin, TextSelection } from '@tiptap/pm/state'
import { EditorView } from '@tiptap/pm/view'
import { afterEach, describe, expect, it } from 'vitest'
import {
  consumeAutoClosedBrackets,
  createAutoCloseBracketsPlugin
} from './auto-close-brackets-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    codeBlock: { group: 'block', content: 'text*', code: true, toDOM: () => ['pre', 0] },
    text: { group: 'inline' }
  },
  marks: { code: { toDOM: () => ['code', 0] } }
})

const pickerOpened: number[] = []

const suggestionMenuStandIn = new Plugin({
  props: {
    handleTextInput(view, from, _to, text) {
      const typed = view.state.doc.textBetween(Math.max(0, from - 1), from) + text
      if (typed !== '[[') return false
      view.dispatch(view.state.tr.insertText(text))
      pickerOpened.push(view.state.selection.from)
      return true
    }
  }
})

let view: EditorView | undefined

function mount(text: string, caret: number, block: 'paragraph' | 'codeBlock' = 'paragraph') {
  const doc = schema.node('doc', null, [schema.node(block, null, text ? [schema.text(text)] : [])])
  const state = EditorState.create({
    doc,
    plugins: [createAutoCloseBracketsPlugin(), suggestionMenuStandIn]
  })
  view = new EditorView(document.createElement('div'), {
    state: state.apply(state.tr.setSelection(TextSelection.create(doc, caret + 1)))
  })
  return view
}

function type(v: EditorView, text: string) {
  for (const char of text) {
    const { from, to } = v.state.selection
    const handled = v.someProp('handleTextInput', (f) => f(v, from, to, char, () => v.state.tr))
    if (!handled) v.dispatch(v.state.tr.insertText(char, from, to))
  }
}

function backspace(v: EditorView) {
  const event = new KeyboardEvent('keydown', { key: 'Backspace' })
  if (!v.someProp('handleKeyDown', (f) => f(v, event))) {
    const { from } = v.state.selection
    v.dispatch(v.state.tr.delete(from - 1, from))
  }
}

const text = (v: EditorView) => v.state.doc.textContent
/** Caret as an offset into the block text, so assertions read like the screen. */
const caret = (v: EditorView) => v.state.selection.from - 1

afterEach(() => {
  view?.destroy()
  view = undefined
  pickerOpened.length = 0
})

describe('( pairing', () => {
  it('writes () with the caret inside', () => {
    const v = mount('', 0)
    type(v, '(')
    expect(text(v)).toBe('()')
    expect(caret(v)).toBe(1)
  })

  it('lets a second ( through unpaired, so the (( portal trigger can open', () => {
    const v = mount('', 0)
    type(v, '((')
    expect(text(v)).toBe('((')
    expect(caret(v)).toBe(2)
  })

  it('types over the closer it wrote', () => {
    const v = mount('', 0)
    type(v, '(a)')
    expect(text(v)).toBe('(a)')
    expect(caret(v)).toBe(3)
  })

  it('leaves a ( in front of a word alone', () => {
    const v = mount('word', 0)
    type(v, '(')
    expect(text(v)).toBe('(word')
  })

  it('does not type over a ) that closes something else', () => {
    const v = mount('a)', 1)
    type(v, ')')
    expect(text(v)).toBe('a))')
  })

  it('pairs inside a sentence before a space', () => {
    const v = mount('see  now', 4)
    type(v, '(')
    expect(text(v)).toBe('see () now')
    expect(caret(v)).toBe(5)
  })

  it('leaves code blocks alone', () => {
    const v = mount('', 0, 'codeBlock')
    type(v, '(')
    expect(text(v)).toBe('(')
  })

  it('removes both halves with Backspace between an empty pair', () => {
    const v = mount('', 0)
    type(v, '(')
    backspace(v)
    expect(text(v)).toBe('')
  })

  it('keeps ordinary Backspace for a pair that holds text', () => {
    const v = mount('', 0)
    type(v, '(a')
    backspace(v)
    expect(text(v)).toBe('()')
  })
})

describe('[[ pairing', () => {
  it('writes [[]] with the caret inside and still opens the picker', () => {
    const v = mount('', 0)
    type(v, '[[')
    expect(text(v)).toBe('[[]]')
    expect(caret(v)).toBe(2)
    expect(pickerOpened).toEqual([3])
  })

  it('leaves a single [ alone', () => {
    const v = mount('', 0)
    type(v, '[')
    expect(text(v)).toBe('[')
  })

  it('does not pair a [[ typed in front of a word', () => {
    const v = mount('word', 0)
    type(v, '[[')
    expect(text(v)).toBe('[[word')
  })

  it('does not stack on a third [', () => {
    const v = mount('', 0)
    type(v, '[[[')
    expect(text(v)).toBe('[[[]]')
  })

  it('types the closing ]] over the pair', () => {
    const v = mount('', 0)
    type(v, '[[note]]')
    expect(text(v)).toBe('[[note]]')
    expect(caret(v)).toBe(8)
  })

  it('removes the whole empty [[]] with Backspace', () => {
    const v = mount('', 0)
    type(v, '[[')
    backspace(v)
    expect(text(v)).toBe('')
  })

  it('leaves code blocks alone', () => {
    const v = mount('', 0, 'codeBlock')
    type(v, '[[')
    expect(text(v)).toBe('[[')
  })
})

describe('consumeAutoClosedBrackets', () => {
  const host = (v: EditorView) => ({ _tiptapEditor: { view: v } })

  it('drops the ]] left behind once the picker cleared [[ and its query', () => {
    const v = mount('see ]]', 4)
    consumeAutoClosedBrackets(host(v))
    expect(text(v)).toBe('see ')
  })

  it('leaves a link being edited in place alone', () => {
    const v = mount('[[]]', 2)
    consumeAutoClosedBrackets(host(v))
    expect(text(v)).toBe('[[]]')
  })
})
