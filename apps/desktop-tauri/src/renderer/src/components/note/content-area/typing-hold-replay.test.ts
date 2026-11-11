/**
 * Typing the editor refuses while the window holds it for an outside edit is not lost: it goes in
 * once the hold ends, over the edit when the edit applied. Typing that touches what the edit
 * changed stays in the note after the change, and the move is logged; typing the editor still
 * holds when it closes is logged.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'
import type { PartialBlock } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

const warn = vi.hoisted(() => vi.fn())
vi.mock('@/lib/logger', () => {
  const quiet = () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    verbose: vi.fn(),
    log: vi.fn()
  })
  return {
    log: quiet(),
    createLogger: (scope: string) => (scope === 'TypingHold' ? { ...quiet(), warn } : quiet())
  }
})
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { typingHoldOf, type TypingHold } from '@/sync/typing-hold'
import { mountTestEditor, para, unmountTestEditors } from './portal/portal-test-editor'
import { registerEditorPlugin } from './register-editor-plugin'
import { createTypingHoldPlugin } from './typing-hold-plugin'

afterEach(() => {
  unmountTestEditors()
  warn.mockReset()
})

function mountNote(texts: string[] = ['Alpha line.', 'Bravo line.', 'Charlie line.']) {
  const mounted = mountTestEditor(texts.map((text) => para(text)))
  const hold = typingHoldOf(mounted.doc)
  const unregister = registerEditorPlugin(mounted.editor, createTypingHoldPlugin(hold))
  return { ...mounted, hold, unregister }
}

/** The outside edit as the core feeds it: the whole body replaced by the file's blocks. */
function feedOutsideEdit(doc: Y.Doc, hold: TypingHold, texts: string[]): void {
  const core = new Y.Doc()
  Y.applyUpdate(core, Y.encodeStateAsUpdate(doc))
  const before = Y.encodeStateVector(core)
  const blocks: PartialBlock[] = texts.map((text) => para(text))
  const file = mountTestEditor(blocks).doc.getXmlFragment(CRDT_FRAGMENT_NAME)
  const body = core.getXmlFragment(CRDT_FRAGMENT_NAME)
  core.transact(() => {
    body.delete(0, body.length)
    body.insert(
      0,
      file.toArray().map((node) => node.clone())
    )
  })
  hold.feed(() => Y.applyUpdate(doc, Y.encodeStateAsUpdate(core, before), 'remote'))
}

function placeCaret(view: EditorView, text: string, offset: number): void {
  let at = -1
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && node.textContent === text) at = pos + 1 + offset
    return at === -1
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

/** One keystroke at the caret, as ProseMirror dispatches it. */
function type(view: EditorView, text: string): void {
  view.dispatch(view.state.tr.insertText(text))
}

function blockTexts(view: EditorView): string[] {
  const texts: string[] = []
  view.state.doc.descendants((node) => {
    if (node.isTextblock) texts.push(node.textContent)
    return !node.isTextblock
  })
  return texts
}

/** The note's text as the document the host stores holds it. */
function storedText(doc: Y.Doc): string {
  return doc.getXmlFragment(CRDT_FRAGMENT_NAME).toJSON()
}

function caret(view: EditorView): string {
  const { $head } = view.state.selection
  return `${$head.parent.textContent} @${$head.parentOffset}`
}

describe('typing refused during a hold', () => {
  it('goes in, in the order typed, when the host releases the hold', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 11)
    hold.hold(1, 2000)
    for (const key of [' ', 'n', 'e', 'w']) type(view, key)
    expect(blockTexts(view)[0]).toBe('Alpha line.')

    hold.release(1)
    expect(blockTexts(view)).toEqual(['Alpha line. new', 'Bravo line.', 'Charlie line.'])
    expect(caret(view)).toBe('Alpha line. new @15')
    expect(storedText(doc)).toContain('Alpha line. new')
    expect(warn).not.toHaveBeenCalled()
  })

  it('goes in when the hold runs out', () => {
    vi.useFakeTimers()
    try {
      const { view, hold } = mountNote()
      placeCaret(view, 'Bravo line.', 0)
      hold.hold(1, 2000)
      type(view, 'X')
      vi.advanceTimersByTime(2000)
      expect(blockTexts(view)[1]).toBe('XBravo line.')
    } finally {
      vi.useRealTimers()
    }
  })

  it('waits for the release of the hold it was refused in', () => {
    const { view, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 0)
    hold.hold(2, 2000)
    type(view, 'X')
    hold.release(1)
    expect(blockTexts(view)[0]).toBe('Alpha line.')
    hold.release(2)
    expect(blockTexts(view)[0]).toBe('XAlpha line.')
  })

  it('goes in over the outside edit, where it was typed, when the edit changed other blocks', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Bravo line.', 5)
    hold.hold(1, 2000)
    for (const key of [' ', 'n', 'e', 'w']) type(view, key)

    feedOutsideEdit(doc, hold, ['Alpha EXT line.', 'Bravo line.', 'Charlie line. tail'])
    expect(blockTexts(view)).toEqual(['Alpha EXT line.', 'Bravo new line.', 'Charlie line. tail'])
    expect(caret(view)).toBe('Bravo new line. @9')
    expect(storedText(doc)).toContain('Bravo new line.')
    expect(warn).not.toHaveBeenCalled()
  })

  it('goes in over a frame of another window that came during the hold', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Charlie line.', 13)
    hold.hold(1, 2000)
    type(view, '!')
    // Another window's frame, between two refused keystrokes.
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(other)
    let text = other.getXmlFragment(CRDT_FRAGMENT_NAME).get(0)
    while (text instanceof Y.XmlElement) text = text.get(0)
    text.insert(0, '>> ')
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before), 'remote')
    type(view, '?')

    hold.release(1)
    expect(blockTexts(view)).toEqual(['>> Alpha line.', 'Bravo line.', 'Charlie line.!?'])
  })

  it('stays in the note, after the change, when the edit rewrote the text it was typed in', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Bravo line.', 8)
    hold.hold(1, 2000)
    for (const key of ['x', 'y']) type(view, key)

    feedOutsideEdit(doc, hold, ['Alpha line.', 'Bravo row.', 'Charlie line.'])
    expect(blockTexts(view)).toEqual(['Alpha line.', 'Bravo rowxy.', 'Charlie line.'])
    expect(storedText(doc)).toContain('Bravo rowxy.')
    expect(warn).toHaveBeenCalledWith(
      'Typing held for an outside edit touched what the edit changed',
      { moved: 2, skipped: 0, unplaced: 0 }
    )
  })

  it.each([
    ['in the middle of the note', 'Bravo line.', 5, ['Alpha line.', 'Charlie line.']],
    ['at the start of the note', 'Alpha line.', 0, ['Bravo line.', 'Charlie line.']],
    ['at the end of the note', 'Charlie line.', 5, ['Alpha line.', 'Bravo line.']],
    ['after the last character', 'Charlie line.', 13, ['Alpha line.', 'Bravo line.']]
  ])(
    'stays one run of text when the edit removed the block it was typed in, %s',
    (_, typedIn, offset, after) => {
      const { view, doc, hold } = mountNote()
      placeCaret(view, typedIn, offset)
      hold.hold(1, 2000)
      for (const key of ['x', 'y']) type(view, key)

      feedOutsideEdit(doc, hold, after)
      const texts = blockTexts(view)
      if (_.startsWith('probe'))
        throw new Error('GOT ' + JSON.stringify(texts) + JSON.stringify(warn.mock.calls))
      expect(texts.filter((text) => text.includes('x') || text.includes('y'))).toEqual(['xy'])
      expect(texts.filter((text) => text !== 'xy')).toEqual(after)
      expect(storedText(doc)).toContain('xy')
    }
  )

  it('leaves out a refused deletion of text the edit changed, and keeps the edit', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Bravo line.', 11)
    hold.hold(1, 2000)
    const { from } = view.state.selection
    view.dispatch(view.state.tr.delete(from - 5, from))

    feedOutsideEdit(doc, hold, ['Alpha line.', 'Bravo lines.', 'Charlie line.'])
    expect(blockTexts(view)).toEqual(['Alpha line.', 'Bravo lines.', 'Charlie line.'])
    expect(warn).toHaveBeenCalledWith(
      'Typing held for an outside edit touched what the edit changed',
      { moved: 0, skipped: 1, unplaced: 0 }
    )
  })

  it('does not go in when the document closes, and the editor logs it when it goes', async () => {
    const { view, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 0)
    hold.hold(1, 2000)
    type(view, 'X')
    hold.end()
    expect(blockTexts(view)[0]).toBe('Alpha line.')

    unmountTestEditors()
    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('Typing refused by a hold went with its editor plugin', {
      dropped: 1
    })
  })

  it('logs the typing it holds when its plugin goes and the editor stays', async () => {
    const { view, hold, unregister } = mountNote()
    placeCaret(view, 'Alpha line.', 0)
    hold.hold(1, 2000)
    type(view, 'X')
    unregister?.()
    expect(view.isDestroyed).toBe(false)

    await Promise.resolve()
    expect(warn).toHaveBeenCalledWith('Typing refused by a hold went with its editor plugin', {
      dropped: 1
    })
  })

  it('keeps the typing it holds when the editor reconfigures its plugins', async () => {
    const { view, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 0)
    hold.hold(1, 2000)
    type(view, 'X')
    view.updateState(view.state.reconfigure({ plugins: [...view.state.plugins] }))

    await Promise.resolve()
    hold.release(1)
    expect(blockTexts(view)[0]).toBe('XAlpha line.')
    expect(warn).not.toHaveBeenCalled()
  })
})
