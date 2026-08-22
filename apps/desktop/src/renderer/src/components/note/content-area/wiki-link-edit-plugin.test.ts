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
import { describe, expect, it, vi } from 'vitest'
import {
  activeRunWikiLink,
  createWikiLinkEditPlugin,
  findWikiLinkRunAt,
  isEditingWikiLinkText,
  openWikiLinkForSelection,
  replaceActiveRunWithWikiLink
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

  // The label a heading link carries is written when the link is, so editing one
  // starts from `[[A#B|B]]` with the caret at the end of the TARGET — typing a
  // new label there necessarily leaves the old one trailing behind it.
  it('drops the stale label when a new one is typed in front of it', () => {
    const opened = keyDown(stateWith([chip({ target: 'A#B', alias: 'B' })], 2), 'Backspace').state
    expect(paragraphText(opened)).toBe('[[A#B|B]]')

    const typed = opened.apply(opened.tr.insertText('|Yeni', opened.selection.from))
    expect(paragraphText(typed)).toBe('[[A#B|Yeni|B]]')

    const closed = typed.apply(
      typed.tr.setSelection(TextSelection.create(typed.doc, typed.doc.content.size - 1))
    )
    expect(firstWikiLink(closed)?.attrs).toMatchObject({ target: 'A#B', alias: 'Yeni' })
  })
})

/**
 * A chip reads as its markdown while the caret is parked beside it — either
 * side, arrow key or mouse click, since this keys off the SELECTION and not off
 * a keystroke.
 *
 * Every assertion here is about decorations, and that is the point: the document
 * is untouched. Swapping the node for text on caret movement would push a Y.Doc
 * update to every device and put the cursor move on the Yjs undo stack, so the
 * next Cmd+Z would undo the caret instead of the paragraph the user deleted.
 */
describe('markdown shown beside the caret', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  function decorationsOf(state: EditorState): any[] {
    const plugin = createWikiLinkEditPlugin()
    const set = plugin.props.decorations!.call(plugin, state)
    if (!set) return []
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return (
      (set as any)
        .find()
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((d: any) => ({
          from: d.from,
          to: d.to,
          class: d.type.attrs?.class,
          // `sourceText`, not `raw`: `raw` is ProseMirror's own widget flag.
          raw: d.spec?.sourceText
        }))
    )
  }

  // `a ` is 1..3, the chip 3..4, ` b` 4..6.
  function sentence(attrs: Record<string, unknown>, cursorAt: number): EditorState {
    return stateWith([schema.text('a '), chip(attrs), schema.text(' b')], cursorAt)
  }

  it('shows the markdown when the caret sits on the right of the chip', () => {
    const found = decorationsOf(sentence({ target: 'Toplantı' }, 4))

    // The widget sorts ahead of the node decoration: it sits at the chip's
    // start with `side: -1`, so the markdown renders where the chip was.
    expect(found).toEqual([
      { from: 3, to: 3, class: undefined, raw: '[[Toplantı]]' },
      { from: 3, to: 4, class: 'wiki-link-hidden', raw: undefined }
    ])
  })

  it('shows it on the left of the chip too — the old flow only worked from the right', () => {
    const found = decorationsOf(sentence({ target: 'Toplantı' }, 3))

    expect(found.map((d) => d.raw ?? d.class)).toEqual(['[[Toplantı]]', 'wiki-link-hidden'])
  })

  it('writes the alias out, exactly as the vault file holds it', () => {
    const found = decorationsOf(
      sentence({ target: 'Continent#North America', alias: 'the north' }, 4)
    )

    expect(found.find((d) => d.raw)?.raw).toBe('[[Continent#North America|the north]]')
  })

  it('paints nothing once the caret is a character away', () => {
    expect(decorationsOf(sentence({ target: 'Toplantı' }, 2))).toEqual([])
    expect(decorationsOf(sentence({ target: 'Toplantı' }, 5))).toEqual([])
  })

  it('paints nothing while text is selected — that is a selection, not a caret', () => {
    const state = sentence({ target: 'Toplantı' }, 4)
    const selected = state.apply(state.tr.setSelection(TextSelection.create(state.doc, 1, 4)))

    expect(decorationsOf(selected)).toEqual([])
  })

  it('shows both when the caret sits between two chips', () => {
    const state = stateWith([chip({ target: 'A' }), chip({ target: 'B' })], 2)
    const raws = decorationsOf(state)
      .map((d) => d.raw)
      .filter(Boolean)

    expect(raws).toEqual(['[[A]]', '[[B]]'])
  })

  /**
   * The one caret position this must NOT paint: the one a menu pick just left
   * behind. `replaceActiveRunWithWikiLink` writes no trailing space — a link
   * picked inside a sentence must not add a character to it — so the caret ends
   * up against the new chip, and painting there would show the user the raw
   * `[[Toplantı]]` of the link they just made. The markdown belongs to the
   * gesture of moving TO a link, which is why the paint returns the moment the
   * caret is placed there rather than left there.
   */
  it('leaves the chip a chip in the instant the menu writes it', () => {
    const opened = keyDown(stateWith([chip({ target: 'A' })], 2), 'Backspace').state
    const view = viewOf(opened)

    expect(
      replaceActiveRunWithWikiLink({ _tiptapEditor: { view } } as never, { target: 'Toplantı' })
    ).toBe(true)

    // The caret really is beside it — without that this test would pass on the
    // chip simply not being adjacent.
    const caret = view.state.selection.from
    expect(view.state.doc.resolve(caret).nodeBefore?.type.name).toBe('wikiLink')
    expect(decorationsOf(view.state)).toEqual([])

    // Move away and come back: now it is a caret movement like any other.
    const away = view.state.apply(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, 0))
    )
    const back = away.apply(away.tr.setSelection(TextSelection.create(away.doc, caret)))

    expect(decorationsOf(back).map((d) => d.raw ?? d.class)).toEqual([
      '[[Toplantı]]',
      'wiki-link-hidden'
    ])
  })
})

describe('openWikiLinkForSelection', () => {
  function selectionState(text: string, from: number, to: number): EditorState {
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text(text)])])
    const state = EditorState.create({ doc, plugins: [createWikiLinkEditPlugin()] })
    return state.apply(state.tr.setSelection(TextSelection.create(state.doc, from, to)))
  }

  function editorOf(view: ReturnType<typeof viewOf>) {
    return {
      _tiptapEditor: {
        view,
        get state() {
          return view.state
        }
      }
    }
  }

  it('turns the selection into a link whose target is still unchosen', () => {
    // `Kuzey Amerika` is characters 3..16 of the paragraph (doc offsets 4..17).
    const view = viewOf(selectionState('bkz Kuzey Amerika ve', 5, 18))
    expect(openWikiLinkForSelection(editorOf(view) as never)).toBe(true)

    expect(paragraphText(view.state)).toBe('bkz [[|Kuzey Amerika]] ve')
    // The caret is right after the `[[`, which is where the suggestion menu
    // anchors its query window — the `|alias` sits behind it, invisible to the
    // query and untouched by typing.
    expect(view.state.selection.from).toBe(5 + 2)
    expect(activeRunWikiLink(editorOf(view) as never)).toEqual({
      target: '',
      alias: 'Kuzey Amerika'
    })
  })

  it('opens the menu only after the text and caret are in place', () => {
    const view = viewOf(selectionState('bir cümle', 1, 4))
    const seen: Array<{ text: string; caret: number }> = []

    openWikiLinkForSelection(editorOf(view) as never, {
      openMenu: () =>
        seen.push({ text: paragraphText(view.state), caret: view.state.selection.from })
    })

    expect(seen).toEqual([{ text: '[[|bir]] cümle', caret: 3 }])
  })

  it('strips the characters that would break the grammar out of the label', () => {
    const view = viewOf(selectionState('a [x|y] b', 3, 8))
    expect(openWikiLinkForSelection(editorOf(view) as never)).toBe(true)
    expect(paragraphText(view.state)).toBe('a [[|xy]] b')
  })

  it('declines a collapsed selection and one that is only syntax characters', () => {
    const collapsed = viewOf(selectionState('metin', 2, 2))
    expect(openWikiLinkForSelection(editorOf(collapsed) as never)).toBe(false)

    const unusable = viewOf(selectionState('a || b', 3, 5))
    expect(openWikiLinkForSelection(editorOf(unusable) as never)).toBe(false)
    expect(paragraphText(unusable.state)).toBe('a || b')
  })

  it('carries the selection marks so the finished chip keeps them', () => {
    const doc = schema.node('doc', null, [
      schema.node('paragraph', null, [schema.text('kalın', [schema.marks.bold.create()])])
    ])
    const base = EditorState.create({ doc, plugins: [createWikiLinkEditPlugin()] })
    const view = viewOf(base.apply(base.tr.setSelection(TextSelection.create(base.doc, 1, 6))))

    expect(openWikiLinkForSelection(editorOf(view) as never)).toBe(true)
    expect(
      view.state.doc
        .resolve(3)
        .marks()
        .map((mark) => mark.type.name)
    ).toEqual(['bold'])
  })

  // Abandoning the picker must not leave `[[|Kuzey Amerika]]` behind: that text
  // is what would be written to the vault file, verbatim.
  it('unwraps back to the plain text when no target is ever picked', () => {
    const view = viewOf(selectionState('bkz Kuzey Amerika ve', 5, 18))
    openWikiLinkForSelection(editorOf(view) as never)

    const closed = view.state.apply(
      view.state.tr.setSelection(
        TextSelection.create(view.state.doc, view.state.doc.content.size - 1)
      )
    )

    expect(firstWikiLink(closed)).toBeNull()
    expect(paragraphText(closed)).toBe('bkz Kuzey Amerika ve')
  })
})

/**
 * Following a link, driven through the handler ProseMirror actually calls.
 *
 * This is the whole point of the fix and cannot be tested through a DOM click:
 * a `click` event fires at mouseup, by which time the chip has been hidden to
 * make room for the markdown paint and the event has been retargeted to the
 * paragraph. `handleClickOn` is handed the node ProseMirror resolved from the
 * MOUSEDOWN position, so the repaint cannot take it away.
 */
describe('clicking a chip follows the link', () => {
  function clickOn(
    node: ProseMirrorNode,
    options: { direct?: boolean; onNavigate?: boolean } & Partial<MouseEvent> = {}
  ) {
    const { direct = true, onNavigate: wantsCallback = true, ...eventProps } = options
    const onNavigate = vi.fn()
    const plugin = createWikiLinkEditPlugin(wantsCallback ? { onNavigate } : {})
    const view = viewOf(stateWith([chip({ target: 'A' })], 1))

    const handled = plugin.props.handleClickOn!.call(
      plugin,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      view as any,
      1,
      node,
      0,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {
        button: 0,
        shiftKey: false,
        altKey: false,
        metaKey: false,
        ctrlKey: false,
        ...eventProps
      } as any,
      direct
    )

    return { handled, onNavigate }
  }

  it('navigates on a direct left click, and takes the mouseup with it', () => {
    const { handled, onNavigate } = clickOn(chip({ target: 'Toplantı' }))

    expect(onNavigate).toHaveBeenCalledWith('Toplantı')
    // True is what makes PM `preventDefault()` the mouseup — without it the
    // caret parks beside the chip and the markdown paint appears anyway.
    expect(handled).toBe(true)
  })

  it('trims the target, exactly as the DOM handler it replaces did', () => {
    const { onNavigate } = clickOn(chip({ target: '  Launch Plan  ' }))

    expect(onNavigate).toHaveBeenCalledWith('Launch Plan')
  })

  it('carries the heading through — the link points at the heading, not the note', () => {
    const { onNavigate } = clickOn(chip({ target: 'Continent#North America', alias: 'the north' }))

    expect(onNavigate).toHaveBeenCalledWith('Continent#North America')
  })

  it('ignores an indirect click — that is a click in the paragraph', () => {
    const paragraph = stateWith([chip({ target: 'A' })], 1).doc.firstChild!
    const { handled, onNavigate } = clickOn(paragraph, { direct: false })

    expect(handled).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('ignores a node that is not a wiki link', () => {
    const { handled, onNavigate } = clickOn(schema.text('plain'))

    expect(handled).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  // Left alone on purpose: shift-click extends a selection, and the rest stay
  // free for an open-in-new-tab gesture.
  const modified: Array<[string, Partial<MouseEvent>]> = [
    ['shift', { shiftKey: true }],
    ['alt', { altKey: true }],
    ['meta', { metaKey: true }],
    ['ctrl', { ctrlKey: true }],
    ['middle/right button', { button: 1 }]
  ]

  it.each(modified)('leaves a %s click to the default behaviour', (_label, eventProps) => {
    const { handled, onNavigate } = clickOn(chip({ target: 'A' }), eventProps)

    expect(handled).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  it('does nothing on a chip with no target', () => {
    const { handled, onNavigate } = clickOn(chip({ target: '   ' }))

    expect(handled).toBe(false)
    expect(onNavigate).not.toHaveBeenCalled()
  })

  // Surfaces that mount the plugin only for its editing behaviour must keep
  // ProseMirror's own click handling rather than swallowing the event.
  it('falls through when no navigation callback is configured', () => {
    expect(clickOn(chip({ target: 'A' }), { onNavigate: false }).handled).toBe(false)
  })
})
