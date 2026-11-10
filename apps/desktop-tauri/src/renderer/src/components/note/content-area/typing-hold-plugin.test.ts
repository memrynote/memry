/**
 * While the window holds typing for an outside edit, the editor refuses its own changes, undo and
 * redo included, and those of a composition that began during the hold, and still takes the
 * document's and those of a composition that ran when the hold began; once released it takes
 * typing again.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { redo, undo, yUndoPluginKey } from 'y-prosemirror'
import * as Y from 'yjs'
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
import { typingHoldOf } from '@/sync/typing-hold'
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
