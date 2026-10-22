/**
 * A drop into a hidden block is refused; a drop at either edge of it, the
 * nearest visible gap, and an edit of visible text are not.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { registerEditorPlugin } from '../register-editor-plugin'
import { createPortalDropGuardPlugin } from './portal-drop-guard-plugin'
import { para, unmountTestEditors } from './portal-test-editor'
import { getPortalWindowState } from './portal-window-plugin'
import { mountPortalWindow } from './portal-window-test-editor'

afterEach(unmountTestEditors)

function mount() {
  const mounted = mountPortalWindow(
    [para('A ^aaaa1'), para('Hidden ^hid01', [para('inner')]), para('B ^bbbb1')],
    { kind: 'blocks', note: 'src', blocks: ['aaaa1', 'bbbb1'], open: {} }
  )
  registerEditorPlugin(mounted.editor, createPortalDropGuardPlugin())
  const [hidden] = getPortalWindowState(mounted.view)!.hiddenSpans
  return { ...mounted, hidden }
}

describe('portal window drop guard', () => {
  it('refuses content dropped inside a hidden block', () => {
    const { view, hidden } = mount()
    const before = view.state.doc
    view.dispatch(view.state.tr.insertText('dropped', hidden.from + 3))
    expect(view.state.doc.eq(before)).toBe(true)
  })

  it('accepts a block dropped at the edge of the hidden block, and edits of visible text', () => {
    const { view, hidden } = mount()
    const dragged = view.state.schema.nodes.blockContainer.createAndFill()!
    const size = view.state.doc.nodeSize
    view.dispatch(view.state.tr.insert(hidden.from, dragged))
    expect(view.state.doc.nodeSize).toBeGreaterThan(size)
    const textBefore = view.state.doc.textContent
    view.dispatch(view.state.tr.insertText('x', 3))
    expect(view.state.doc.textContent).not.toBe(textBefore)
  })
})
