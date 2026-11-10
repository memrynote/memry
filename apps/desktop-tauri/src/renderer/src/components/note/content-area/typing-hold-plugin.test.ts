/**
 * While the window holds typing for an outside edit, the editor refuses its own changes, undo and
 * redo included, and those of a composition that began during the hold, and still takes the
 * document's and those of a composition that ran when the hold began; once released it takes
 * typing again. When the outside edit's frame applies, the caret stays where it was, mapped
 * through the edit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { redo, undo, yUndoPluginKey } from 'y-prosemirror'
import * as Y from 'yjs'
import type { PartialBlock } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

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

afterEach(unmountTestEditors)

function mount() {
  const mounted = mountTestEditor([para('first words')])
  const hold = typingHoldOf(mounted.doc)
  registerEditorPlugin(mounted.editor, createTypingHoldPlugin(hold))
  return { ...mounted, hold }
}

/** Makes ProseMirror say a composition runs in `view`, as it does between an IME's start and end. */
function composing(view: EditorView, value: boolean): void {
  Object.defineProperty(view, 'composing', { configurable: true, get: () => value })
}

/** The first text of the document, as the core holds it. */
function firstText(doc: Y.Doc): Y.XmlText {
  let node = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0)
  while (node instanceof Y.XmlElement) node = node.get(0)
  return node
}

describe('typing hold plugin', () => {
  it('refuses typing while held and takes it again once released', () => {
    const { view, hold } = mount()
    hold.hold(1, 2000)
    view.dispatch(view.state.tr.insertText('typed ', 3))
    expect(view.state.doc.textContent).toBe('first words')

    hold.release(1)
    view.dispatch(view.state.tr.insertText('typed ', 3))
    expect(view.state.doc.textContent).toBe('typed first words')
  })

  it('takes the document changing under it while held', () => {
    const { view, doc, hold } = mount()
    hold.hold(1, 2000)
    firstText(doc).insert(0, 'edited ')
    expect(view.state.doc.textContent).toBe('edited first words')
  })

  it('takes a composition that ran when the hold began, whatever ProseMirror marks', () => {
    const { view, hold } = mount()
    composing(view, true)
    hold.compositionStarted()
    hold.hold(1, 2000)
    view.dispatch(view.state.tr.insertText('composed ', 3).setMeta('composition', 1))
    view.dispatch(view.state.tr.insertText('more ', 3))
    expect(view.state.doc.textContent).toBe('more composed first words')
  })

  it('takes the text ProseMirror commits after the end of a composition that ran when the hold began', () => {
    const { view, hold } = mount()
    composing(view, true)
    hold.compositionStarted()
    hold.hold(1, 2000)
    view.dispatch(view.state.tr.insertText('漢', 3).setMeta('composition', 1))

    // The plugin hears compositionend before ProseMirror, which then commits the pending text.
    view.dom.dispatchEvent(new CompositionEvent('compositionend'))
    composing(view, false)
    view.dispatch(view.state.tr.insertText('字', 4).setMeta('composition', 1))
    expect(view.state.doc.textContent).toBe('漢字first words')
  })

  it('refuses a composition that begins while held, and takes it once released', () => {
    const { view, hold } = mount()
    hold.hold(1, 2000)
    composing(view, true)
    hold.compositionStarted()
    view.dispatch(view.state.tr.insertText('composed ', 3).setMeta('composition', 1))
    expect(view.state.doc.textContent).toBe('first words')

    hold.release(1)
    view.dispatch(view.state.tr.insertText('composed ', 3).setMeta('composition', 1))
    expect(view.state.doc.textContent).toBe('composed first words')
  })

  it('refuses a new composition once the one that ran when the hold began ended', () => {
    const { view, hold } = mount()
    composing(view, true)
    hold.compositionStarted()
    hold.hold(1, 2000)
    hold.compositionEnded()
    hold.compositionStarted()
    view.dispatch(view.state.tr.insertText('composed ', 3).setMeta('composition', 2))
    expect(view.state.doc.textContent).toBe('first words')
  })

  it('ends the composition of an editor that goes mid-composition, so no barrier waits for it', async () => {
    const { view, hold } = mount()
    composing(view, true)
    hold.compositionStarted()
    unmountTestEditors()
    await expect(hold.whenNotComposing(0)).resolves.toBe(true)
  })

  it('refuses undo and redo while held and undoes again once released', () => {
    const { view, doc, hold } = mount()
    const undoManager = yUndoPluginKey.getState(view.state)?.undoManager
    undoManager?.stopCapturing()
    view.dispatch(view.state.tr.insertText('typed ', 3))
    undoManager?.stopCapturing()
    view.dispatch(view.state.tr.insertText('more ', 3))
    undo(view.state)
    expect(view.state.doc.textContent).toBe('typed first words')
    let updates = 0
    doc.on('update', () => updates++)

    hold.hold(1, 2000)
    undo(view.state)
    redo(view.state)
    expect(updates).toBe(0)
    expect(view.state.doc.textContent).toBe('typed first words')

    hold.release(1)
    expect(undo(view.state)).toBe(true)
    expect(view.state.doc.textContent).toBe('first words')
  })
})

function mountNote(
  blocks: Array<string | PartialBlock> = ['Alpha line.', 'Bravo line.', 'Charlie line.']
) {
  const mounted = mountTestEditor(
    blocks.map((block) => (typeof block === 'string' ? para(block) : block))
  )
  const hold = typingHoldOf(mounted.doc)
  registerEditorPlugin(mounted.editor, createTypingHoldPlugin(hold))
  return { ...mounted, hold }
}

/**
 * The outside edit as the core feeds it (`replace_doc_body`, Electron's `replaceDocBody`): the
 * whole body deleted and the file's blocks, with new ids, put in its place, as one frame.
 */
function feedOutsideEdit(doc: Y.Doc, hold: TypingHold, blocks: PartialBlock[]): void {
  const core = new Y.Doc()
  Y.applyUpdate(core, Y.encodeStateAsUpdate(doc))
  const before = Y.encodeStateVector(core)
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

/** The caret at `offset` of the text of the `index`th top-level block. */
function placeCaretInBlock(view: EditorView, index: number, offset: number): void {
  let at = -1
  let seen = 0
  view.state.doc.descendants((node, pos) => {
    if (at === -1 && node.isTextblock && seen++ === index) at = pos + 1 + offset
    return at === -1
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, at)))
}

function blockIdAtCaret(view: EditorView): unknown {
  const { $head } = view.state.selection
  return $head.node($head.depth - 1).attrs.id
}

/** The note's top-level blocks, as the core holds them. */
function topBlocks(doc: Y.Doc): Y.XmlElement {
  const group = doc.getXmlFragment(CRDT_FRAGMENT_NAME).get(0)
  if (!(group instanceof Y.XmlElement)) throw new Error('no block group')
  return group
}

function lastText(blocks: Y.XmlElement): Y.XmlText {
  let node = blocks.get(blocks.length - 1)
  while (node instanceof Y.XmlElement) node = node.get(0)
  return node
}

const heading = (text: string, level: number): PartialBlock => ({
  type: 'heading',
  props: { level },
  content: text
})

function caret(view: EditorView): string {
  const { $head } = view.state.selection
  return `${$head.parent.textContent} @${$head.parentOffset}`
}

describe('the outside edit frame', () => {
  it('keeps a caret before the changed range', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 11)
    feedOutsideEdit(doc, hold, [
      para('Alpha line.'),
      para('Bravo EXT line.'),
      para('Charlie line.')
    ])
    expect(view.state.doc.textContent).toBe('Alpha line.Bravo EXT line.Charlie line.')
    expect(caret(view)).toBe('Alpha line. @11')
  })

  it('keeps a caret after the changed range', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Charlie line.', 7)
    feedOutsideEdit(doc, hold, [
      para('Alpha line.'),
      para('Bravo EXT line.'),
      para('Charlie line.')
    ])
    expect(caret(view)).toBe('Charlie line. @7')
  })

  it('moves a caret inside the changed range to the end of its new text', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Bravo line.', 8)
    feedOutsideEdit(doc, hold, [para('Alpha line.'), para('Bravo row.'), para('Charlie line.')])
    expect(caret(view)).toBe('Bravo row. @9')
  })

  it('keeps a caret in a block the edit appends to, with the appended text before it', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Alpha line.', 6)
    feedOutsideEdit(doc, hold, [
      para('Alpha line. tail'),
      para('Bravo line.'),
      para('Charlie line.')
    ])
    expect(caret(view)).toBe('Alpha line. tail @6')
  })

  it('moves the caret of a block the edit removed to the nearest block', () => {
    const { view, doc, hold } = mountNote()
    placeCaret(view, 'Bravo line.', 3)
    feedOutsideEdit(doc, hold, [para('Alpha line.'), para('Charlie line.')])
    expect(view.state.doc.textContent).toBe('Alpha line.Charlie line.')
    expect(caret(view)).toBe('Charlie line. @0')
  })

  it('keeps a caret between two changes of one edit', () => {
    const { view, doc, hold } = mountNote(['Alpha', 'Bravo line', 'Charlie line'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('AlphaX'), para('Bravo line'), para('Charlie lineY')])
    expect(view.state.doc.textContent).toBe('AlphaXBravo lineCharlie lineY')
    expect(caret(view)).toBe('Bravo line @3')
    const ids: unknown[] = []
    view.state.doc.descendants((node) => {
      if (node.type.name === 'blockContainer') ids.push(node.attrs.id)
    })
    expect(ids).toHaveLength(3)
    expect(ids.every((id) => typeof id === 'string' && id !== '')).toBe(true)
  })

  it('keeps a caret in its block when the edit changes every block', () => {
    const { view, doc, hold } = mountNote(['Alpha', 'Bravo line', 'Charlie line'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('Alpha.'), para('Bravo line.'), para('Charlie line.')])
    expect(caret(view)).toBe('Bravo line. @3')
  })

  it('keeps a caret between a block the edit inserts and one it removes', () => {
    const { view, doc, hold } = mountNote(['Alpha', 'Bravo line', 'Charlie line', 'Delta'])
    placeCaret(view, 'Charlie line', 4)
    feedOutsideEdit(doc, hold, [
      para('Intro'),
      para('Alpha'),
      para('Bravo line'),
      para('Charlie line')
    ])
    expect(caret(view)).toBe('Charlie line @4')
  })
})

describe('the outside edit frame, block changes', () => {
  it('keeps a caret in a paragraph the edit turns into a heading', () => {
    const { view, doc, hold } = mountNote(['A', 'Bravo line', 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('A'), heading('Bravo line', 2), para('CX')])
    expect(view.state.selection.$head.parent.type.name).toBe('heading')
    expect(caret(view)).toBe('Bravo line @3')
  })

  it('keeps a caret in a heading whose level the edit changes', () => {
    const { view, doc, hold } = mountNote(['A', heading('Bravo line', 2), 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('A'), heading('Bravo line', 3), para('CX')])
    expect(view.state.selection.$head.parent.attrs.level).toBe(3)
    expect(caret(view)).toBe('Bravo line @3')
  })

  it('keeps a caret in a paragraph the edit turns into a list item and appends to', () => {
    const { view, doc, hold } = mountNote(['A', 'Bravo line', 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [
      para('A'),
      { type: 'bulletListItem', content: 'Bravo line!' },
      para('C')
    ])
    expect(view.state.selection.$head.parent.type.name).toBe('bulletListItem')
    expect(caret(view)).toBe('Bravo line! @3')
  })

  it('keeps a caret in a block the edit changes when it also inserts a block above it', () => {
    const { view, doc, hold } = mountNote(['A', 'Bravo line', 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('A'), para('New'), para('Bravo line!'), para('C')])
    expect(caret(view)).toBe('Bravo line! @3')
  })

  it('keeps a caret in a block the edit changes when it also inserts a block below it', () => {
    const { view, doc, hold } = mountNote(['A', 'Bravo line', 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('A'), para('So Bravo line'), para('New'), para('C')])
    expect(caret(view)).toBe('So Bravo line @6')
  })

  it('keeps a caret in a block the edit changes when it also removes the block above it', () => {
    const { view, doc, hold } = mountNote(['A', 'Old', 'Bravo line', 'C'])
    placeCaret(view, 'Bravo line', 3)
    feedOutsideEdit(doc, hold, [para('A'), para('Bravo line!'), para('C')])
    expect(caret(view)).toBe('Bravo line! @3')
  })

  it.each([
    [0, 0],
    [1, 1],
    [2, 2],
    [3, 2],
    [4, 3]
  ])('maps a caret at %i of a block that loses a repeated letter to %i', (from, to) => {
    const { view, doc, hold } = mountNote(['Alpha', 'xaab'])
    placeCaret(view, 'xaab', from)
    feedOutsideEdit(doc, hold, [para('Intro'), para('Alpha'), para('xab')])
    expect(caret(view)).toBe(`xab @${to}`)
  })

  it('keeps a caret near its block past the block edit cap', () => {
    const texts = Array.from({ length: 1100 }, (_, i) => `Block ${i}`)
    const { view, doc, hold } = mountNote(texts)
    placeCaret(view, 'Block 600', 2)
    // An empty block after each: more block insertions than the diff follows.
    feedOutsideEdit(
      doc,
      hold,
      texts.flatMap((text) => [para(text), para('')])
    )
    // Past the cap the blocks pair by index: the caret's block 600 is the new block 600.
    expect(caret(view)).toBe('Block 300 @2')
  })
})

describe("another window's frame", () => {
  it('keeps the caret in its block, as y-prosemirror maps it, when it changes two places', () => {
    const { view, doc } = mountNote(['Echo', 'Echo', 'Tail'])
    placeCaretInBlock(view, 1, 2)
    const caretBlock = blockIdAtCaret(view)

    // Another window puts an `Echo` block on top and edits the last one, both in one frame. By
    // content alone the caret's `Echo` is the first; the frame keeps it the second one.
    const other = new Y.Doc()
    Y.applyUpdate(other, Y.encodeStateAsUpdate(doc))
    const before = Y.encodeStateVector(other)
    const blocks = topBlocks(other)
    const echo = topBlocks(mountTestEditor([para('Echo')]).doc).get(0)
    other.transact(() => {
      blocks.insert(0, [echo.clone()])
      lastText(blocks).insert(4, 'Z')
    })
    Y.applyUpdate(doc, Y.encodeStateAsUpdate(other, before), 'remote')

    expect(view.state.doc.textContent).toBe('EchoEchoEchoTailZ')
    expect(blockIdAtCaret(view)).toBe(caretBlock)
    expect(caret(view)).toBe('Echo @2')
  })
})
