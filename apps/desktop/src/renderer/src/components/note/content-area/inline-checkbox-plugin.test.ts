/**
 * `[ ] ` typed at the head of a table cell, driven through a real ProseMirror
 * state.
 *
 * A hand-built schema rather than BlockNote's — the same approach
 * `wiki-link-edit-plugin.test.ts` takes: the plugin only ever asks for a
 * `tableParagraph` parent, an `inlineCheckbox` node type and text, and a real
 * state is what makes `appendTransaction` run for real, which is the half no
 * assertion on a helper could reach.
 *
 * The negative cases are the important ones. BlockNote's own input rules own
 * this gesture everywhere outside a cell, and a plugin that fired in a
 * paragraph would race them for every checklist anybody types.
 */

import { Schema } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import { createInlineCheckboxPlugin, matchLeadingCheckboxToken } from './inline-checkbox-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    table: { group: 'block', content: 'tableRow+', toDOM: () => ['table', 0] },
    tableRow: { content: 'tableCell+', toDOM: () => ['tr', 0] },
    // The shape that makes a checklist BLOCK impossible in a cell, and the
    // reason this node exists: `tableParagraph` is `inline*`, and it is the
    // only thing a cell can hold.
    tableCell: { content: 'tableContent+', toDOM: () => ['td', 0] },
    tableParagraph: { group: 'tableContent', content: 'inline*', toDOM: () => ['p', 0] },
    inlineCheckbox: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: { checked: { default: false } },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  }
})

/** A cell holding `text`, caret at its end. Cell text starts at position 4. */
function cellState(text: string): EditorState {
  const para = schema.node('tableParagraph', null, text ? [schema.text(text)] : [])
  const doc = schema.node('doc', null, [
    schema.node('table', null, [
      schema.node('tableRow', null, [schema.node('tableCell', null, [para])])
    ])
  ])
  const state = EditorState.create({ doc, plugins: [createInlineCheckboxPlugin()] })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 4 + text.length)))
}

/** A plain paragraph holding `text`, caret at its end. Text starts at 1. */
function paragraphState(text: string): EditorState {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
  const state = EditorState.create({ doc, plugins: [createInlineCheckboxPlugin()] })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1 + text.length)))
}

/** Types one character at the caret and lets the plugin see the result. */
function type(state: EditorState, char: string): EditorState {
  return state.apply(state.tr.insertText(char, state.selection.from))
}

function checkboxIn(state: EditorState): { checked: unknown } | null {
  let found: { checked: unknown } | null = null
  state.doc.descendants((node) => {
    if (node.type.name === 'inlineCheckbox') found = { checked: node.attrs.checked }
  })
  return found
}

/** The cell's text, with the box rendered as an object-replacement character. */
function cellText(state: EditorState): string {
  let text = ''
  state.doc.descendants((node) => {
    if (node.type.name === 'tableParagraph') text = node.textBetween(0, node.content.size, '', '￼')
  })
  return text
}

describe('matchLeadingCheckboxToken', () => {
  it('reads the ticked state off the token', () => {
    expect(matchLeadingCheckboxToken('[ ] ')).toBe(false)
    expect(matchLeadingCheckboxToken('[x] ')).toBe(true)
    expect(matchLeadingCheckboxToken('[X] ')).toBe(true)
  })

  it('declines anything that is not exactly the token', () => {
    // #given the trailing space IS the trigger — without it the user is still
    // typing, and `[ ]` alone is four characters somebody may well have meant
    expect(matchLeadingCheckboxToken('[ ]')).toBeNull()
    expect(matchLeadingCheckboxToken('[y] ')).toBeNull()
    expect(matchLeadingCheckboxToken('a[ ] ')).toBeNull()
    expect(matchLeadingCheckboxToken('[] ')).toBeNull()
    expect(matchLeadingCheckboxToken('')).toBeNull()
  })
})

describe('typing `[ ] ` in a table cell', () => {
  it('replaces the whole token with the node, space included', () => {
    // #given the caret after `[ ]` in a cell
    const state = cellState('[ ]')

    // #when the space that completes the token is typed
    const next = type(state, ' ')

    // #then all four characters are gone and the node is alone in their place.
    // The box's own DOM carries the space that separates it from the label, so
    // a text space here would be a second one — and would leave a TYPED cell
    // holding a different document from the same cell RE-OPENED.
    expect(checkboxIn(next)).toEqual({ checked: false })
    expect(cellText(next)).toBe('￼')
  })

  it('ticks the box for `[x] ` and `[X] `', () => {
    expect(checkboxIn(type(cellState('[x]'), ' '))).toEqual({ checked: true })
    expect(checkboxIn(type(cellState('[X]'), ' '))).toEqual({ checked: true })
  })

  it('leaves the caret after the box, ready for the label', () => {
    // #given / #when
    const next = type(cellState('[ ]'), ' ')

    // #then the node is one position wide, and the caret is just past it —
    // where the label gets typed
    expect(next.selection.$from.parentOffset).toBe(1)
  })

  it('does not fire when the token is not at the head of the cell', () => {
    // #given `[ ] ` mid-sentence is four characters of prose. Promoting it
    // would rewrite text somebody typed on purpose.
    const next = type(cellState('see [ ]'), ' ')

    // #then
    expect(checkboxIn(next)).toBeNull()
    expect(cellText(next)).toBe('see [ ] ')
  })

  it('does not fire on a token that is not a checkbox', () => {
    const next = type(cellState('[y]'), ' ')
    expect(checkboxIn(next)).toBeNull()
    expect(cellText(next)).toBe('[y] ')
  })

  it('does not fire until the space arrives', () => {
    // #given the user has typed `[ ]` and stopped
    const state = cellState('[ ')

    // #when the closing bracket is typed, but not the space
    const next = type(state, ']')

    // #then
    expect(checkboxIn(next)).toBeNull()
    expect(cellText(next)).toBe('[ ]')
  })
})

describe('typing `[ ] ` outside a table cell', () => {
  it('is left entirely to BlockNote, in a plain paragraph', () => {
    // #given the gesture BlockNote's own `checkListItem` input rules own. Two
    // rules firing on one keystroke is a checklist block AND an inline node.
    const next = type(paragraphState('[ ]'), ' ')

    // #then nothing of ours happened; the text is untouched for BlockNote's
    // rule to act on
    expect(checkboxIn(next)).toBeNull()
    expect(next.doc.textContent).toBe('[ ] ')
  })

  it('is left alone for `[x] ` in a paragraph too', () => {
    const next = type(paragraphState('[x]'), ' ')
    expect(checkboxIn(next)).toBeNull()
    expect(next.doc.textContent).toBe('[x] ')
  })
})
