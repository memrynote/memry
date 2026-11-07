/**
 * While the window holds typing for an outside edit, the editor refuses its own changes and
 * still takes the document's and a composition's; once released it takes typing again.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import * as Y from 'yjs'

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

  it('takes a composition while held', () => {
    const { view, hold } = mount()
    hold.hold(1, 2000)
    view.dispatch(view.state.tr.insertText('composed ', 3).setMeta('composition', 1))
    expect(view.state.doc.textContent).toBe('composed first words')
  })
})
