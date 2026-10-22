import { afterEach, describe, expect, it, vi } from 'vitest'
import { NodeSelection, TextSelection } from '@tiptap/pm/state'
import type { PartialBlock } from '@blocknote/core'

vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { registerEditorPlugin } from '../register-editor-plugin'
import { createPortalKeysPlugin, portalSelectionPast } from './portal-keys-plugin'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'

afterEach(unmountTestEditors)

const portal = (): PartialBlock =>
  ({
    type: 'codeBlock',
    props: { language: 'memry-portal' },
    content: '{"note":"src"}'
  }) as PartialBlock

/** The caret at the start (or end) of the block with this text. */
function caretIn(
  view: ReturnType<typeof mountTestEditor>['view'],
  text: string,
  at: 'start' | 'end'
) {
  let target = -1
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text)
      target = at === 'start' ? pos + 1 : pos + node.nodeSize - 1
  })
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, target)))
}

describe('portal keys', () => {
  it('selects the portal before the caret instead of merging into its definition', () => {
    const { editor, view } = mountTestEditor([para('above'), portal(), para('below')])
    registerEditorPlugin(editor, createPortalKeysPlugin())
    caretIn(view, 'below', 'start')

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    )

    expect(view.state.selection).toBeInstanceOf(NodeSelection)
    expect((view.state.selection as NodeSelection).node.firstChild?.attrs.language).toBe(
      'memry-portal'
    )
    expect(editor.document.map((b) => b.type)).toEqual(['paragraph', 'codeBlock', 'paragraph'])
  })

  it('finds the portal past the caret in both directions, and nothing else', () => {
    const { view } = mountTestEditor([para('above'), portal(), para('below'), para('last')])

    caretIn(view, 'above', 'end')
    expect(portalSelectionPast(view.state, 1)).toBeInstanceOf(NodeSelection)
    caretIn(view, 'below', 'start')
    expect(portalSelectionPast(view.state, -1)).toBeInstanceOf(NodeSelection)
    caretIn(view, 'last', 'start')
    expect(portalSelectionPast(view.state, -1)).toBeNull()
  })
})
