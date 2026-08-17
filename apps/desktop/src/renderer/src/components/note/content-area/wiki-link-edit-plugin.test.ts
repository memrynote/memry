/**
 * The un-promote/re-promote round trip, driven through a real ProseMirror state.
 *
 * A hand-built schema rather than BlockNote's: the plugin only ever asks for a
 * `wikiLink` node type, the mark types it carries, and text — and a real state
 * is what makes `appendTransaction` (the re-promotion) run for real, which is
 * the half no assertion on a helper could reach.
 */

import { Schema } from '@tiptap/pm/model'
import type { Node as ProseMirrorNode } from '@tiptap/pm/model'
import { EditorState, TextSelection } from '@tiptap/pm/state'
import type { Transaction } from '@tiptap/pm/state'
import { describe, expect, it } from 'vitest'
import {
  createWikiLinkEditPlugin,
  findWikiLinkRunAt,
  isEditingWikiLinkText
} from './wiki-link-edit-plugin'

const schema = new Schema({
  nodes: {
    doc: { content: 'block+' },
    paragraph: { group: 'block', content: 'inline*', toDOM: () => ['p', 0] },
    wikiLink: {
      group: 'inline',
      inline: true,
      atom: true,
      attrs: {
        target: { default: '' },
        alias: { default: '' },
        bold: { default: false },
        textColor: { default: 'default' }
      },
      toDOM: () => ['span']
    },
    text: { group: 'inline' }
  },
  marks: {
    bold: { toDOM: () => ['strong', 0] },
    textColor: { attrs: { stringValue: { default: 'default' } }, toDOM: () => ['span', 0] }
  }
})

function stateWith(nodes: ProseMirrorNode[], cursorAt: number): EditorState {
  const doc = schema.node('doc', null, [schema.node('paragraph', null, nodes)])
  const state = EditorState.create({ doc, plugins: [createWikiLinkEditPlugin()] })
  return state.apply(state.tr.setSelection(TextSelection.create(state.doc, cursorAt)))
}

function chip(attrs: Record<string, unknown>): ProseMirrorNode {
  return schema.node('wikiLink', attrs)
}

/** A stand-in for `EditorView` carrying only what the plugin touches. */
function viewOf(state: EditorState) {
  const view = {
    state,
    dispatch(tr: Transaction) {
      view.state = view.state.apply(tr)
    }
  }
  return view
}

function keyDown(state: EditorState, key: string, modifiers: Partial<KeyboardEvent> = {}) {
  const plugin = createWikiLinkEditPlugin()
  const view = viewOf(state)
  const handled = plugin.props.handleKeyDown!.call(
    plugin,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    view as any,
    { key, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, ...modifiers } as any
  )
  return { handled, state: view.state }
}

function paragraphText(state: EditorState): string {
  return state.doc.firstChild!.textBetween(0, state.doc.firstChild!.content.size, undefined, '￼')
}

function firstWikiLink(state: EditorState): ProseMirrorNode | null {
  let found: ProseMirrorNode | null = null
  state.doc.descendants((node) => {
    if (!found && node.type.name === 'wikiLink') found = node
  })
  return found
}

describe('findWikiLinkRunAt', () => {
  it('finds the run the offset is strictly inside', () => {
    //          0123456789
    const text = 'a [[Note]] b'
    expect(findWikiLinkRunAt(text, 5)).toEqual({ start: 2, end: 10 })
    expect(findWikiLinkRunAt(text, 3)).toEqual({ start: 2, end: 10 })
    expect(findWikiLinkRunAt(text, 9)).toEqual({ start: 2, end: 10 })
  })

  it('treats both outer edges as outside, which is what re-promotes the run', () => {
    const text = 'a [[Note]] b'
    expect(findWikiLinkRunAt(text, 2)).toBeNull()
    expect(findWikiLinkRunAt(text, 10)).toBeNull()
  })

  it('handles targets with spaces, headings and aliases', () => {
    const text = '[[Toplantı Notları#Kararlar|dün]]'
    expect(findWikiLinkRunAt(text, 20)).toEqual({ start: 0, end: text.length })
  })

  it('finds nothing in unbracketed or half-deleted text', () => {
    expect(findWikiLinkRunAt('[[Note', 3)).toBeNull()
    expect(findWikiLinkRunAt('Note]]', 3)).toBeNull()
    expect(findWikiLinkRunAt('plain text', 3)).toBeNull()
  })

  it('picks the run the caret is in when a block holds several', () => {
    const text = '[[A]] and [[B]]'
    expect(findWikiLinkRunAt(text, 2)).toEqual({ start: 0, end: 5 })
    expect(findWikiLinkRunAt(text, 12)).toEqual({ start: 10, end: 15 })
    expect(findWikiLinkRunAt(text, 7)).toBeNull()
  })
})

describe('wiki-link edit plugin', () => {
  it('un-promotes the chip before the caret on Backspace, caret before the `]]`', () => {
    const { handled, state } = keyDown(stateWith([chip({ target: 'Toplantı' })], 2), 'Backspace')

    expect(handled).toBe(true)
    expect(paragraphText(state)).toBe('[[Toplantı]]')
    expect(firstWikiLink(state)).toBeNull()
    // `[[Toplantı]]` is 12 characters; the caret sits at 10, before the `]]`.
    expect(state.selection.from).toBe(1 + 10)
  })

  // The bug this pins: the menu anchors its query window wherever the caret is
  // when it opens. Opened at the END of the target, the query starts empty, so
  // typing `#` yields the query `#`, the note half is empty, heading mode never
  // engages and the picker reports "no notes found" for a note that plainly
  // exists. Only the ORDER was wrong — the caret ends up in the same place
  // either way, which is why every other assertion here stayed green.
  it('opens the menu while the caret is still just after the `[[`', () => {
    const caretAtOpen: number[] = []
    const view = viewOf(stateWith([chip({ target: 'Toplantı' })], 2))
    const plugin = createWikiLinkEditPlugin({
      openMenu: () => caretAtOpen.push(view.state.selection.from)
    })

    plugin.props.handleKeyDown!.call(
      plugin,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      view as any,
      {
        key: 'Backspace',
        shiftKey: false,
        metaKey: false,
        ctrlKey: false,
        altKey: false
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any
    )

    // Right after the `[[`, so the menu's query window starts where a
    // hand-typed link's would.
    expect(caretAtOpen).toEqual([1 + 2])
    // And only then to the end of the target, which makes the query the target.
    expect(view.state.selection.from).toBe(1 + 2 + 'Toplantı'.length)
  })

  it('un-promotes on ArrowLeft too', () => {
    const { handled, state } = keyDown(stateWith([chip({ target: 'Toplantı' })], 2), 'ArrowLeft')

    expect(handled).toBe(true)
    expect(paragraphText(state)).toBe('[[Toplantı]]')
  })

  it('leaves modified keys alone', () => {
    for (const modifiers of [{ shiftKey: true }, { altKey: true }, { metaKey: true }]) {
      const { handled } = keyDown(stateWith([chip({ target: 'A' })], 2), 'ArrowLeft', modifiers)
      expect(handled).toBe(false)
    }
  })

  it('does nothing when the node before the caret is not a wiki link', () => {
    const { handled } = keyDown(stateWith([schema.text('plain')], 6), 'Backspace')
    expect(handled).toBe(false)
  })

  it('round-trips an alias: open, edit, and close back into one chip', () => {
    const opened = keyDown(stateWith([chip({ target: 'A', alias: 'B' })], 2), 'Backspace').state
    expect(paragraphText(opened)).toBe('[[A|B]]')
    // The caret lands at the end of the TARGET, not after the alias, so a typed
    // `#` names a heading rather than becoming part of the alias.
    expect(opened.selection.from).toBe(1 + 3)

    const typed = opened.apply(opened.tr.insertText('#Kararlar', opened.selection.from))
    expect(paragraphText(typed)).toBe('[[A#Kararlar|B]]')
    expect(firstWikiLink(typed)).toBeNull()

    // Move the caret out of the run: the plugin's appendTransaction closes it.
    const closed = typed.apply(
      typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1))
    )
    const link = firstWikiLink(closed)
    expect(link?.attrs).toMatchObject({ target: 'A#Kararlar', alias: 'B' })
    expect(paragraphText(closed)).toBe('￼')
  })

  it('keeps the caret inside the run from promoting it', () => {
    const opened = keyDown(stateWith([chip({ target: 'A' })], 2), 'Backspace').state
    const typed = opened.apply(opened.tr.insertText('#H', opened.selection.from))

    expect(isEditingWikiLinkText(typed)).toBe(true)
    expect(firstWikiLink(typed)).toBeNull()
    expect(paragraphText(typed)).toBe('[[A#H]]')
  })

  it('carries the chip marks out into the text and back in again', () => {
    const opened = keyDown(
      stateWith([chip({ target: 'A', bold: true, textColor: 'red' })], 2),
      'Backspace'
    ).state

    const marks = opened.doc.resolve(3).marks()
    expect(marks.map((mark) => mark.type.name).sort()).toEqual(['bold', 'textColor'])

    const closed = opened.apply(
      opened.tr.setSelection(TextSelection.create(opened.doc, opened.doc.content.size - 1))
    )
    expect(firstWikiLink(closed)?.attrs).toMatchObject({
      target: 'A',
      bold: true,
      textColor: 'red'
    })
  })

  it('leaves brackets the user deleted as prose instead of restoring the chip', () => {
    const opened = keyDown(stateWith([chip({ target: 'A' })], 2), 'Backspace').state
    // Delete the leading `[[` — a deliberate "this is not a link any more".
    const stripped = opened.apply(opened.tr.delete(1, 3))
    const moved = stripped.apply(
      stripped.tr.setSelection(TextSelection.create(stripped.doc, stripped.doc.content.size - 1))
    )

    expect(firstWikiLink(moved)).toBeNull()
    expect(paragraphText(moved)).toBe('A]]')
  })

  it('dims both bracket pairs while the caret is inside the run', () => {
    const opened = keyDown(stateWith([chip({ target: 'A' })], 2), 'Backspace').state
    const plugin = createWikiLinkEditPlugin()

    const decorations = plugin.props.decorations!.call(plugin, opened)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const found = (decorations as any).find().map((d: any) => [d.from, d.to, d.type.attrs.class])

    // `[[A]]` occupies 1..6, so the bracket pairs are 1..3 and 4..6.
    expect(found).toEqual([
      [1, 3, 'wiki-link-bracket'],
      [4, 6, 'wiki-link-bracket']
    ])
  })

  it('paints nothing once the caret leaves the run', () => {
    const state = stateWith([schema.text('[[A]] tail')], 8)
    const plugin = createWikiLinkEditPlugin()

    expect(isEditingWikiLinkText(state)).toBe(false)
    expect(plugin.props.decorations!.call(plugin, state)).toBeNull()
  })
})
