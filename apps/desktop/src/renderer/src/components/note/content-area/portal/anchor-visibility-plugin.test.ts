/**
 * The hidden ` ^anchor`, and the rule that an anchor stays on one block.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
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

import { registerEditorPlugin } from '../register-editor-plugin'
import { ANCHOR_HIDDEN_CLASS, createAnchorVisibilityPlugin } from './anchor-visibility-plugin'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'

afterEach(unmountTestEditors)

function mount(blocks: Parameters<typeof mountTestEditor>[0]) {
  const mounted = mountTestEditor(blocks)
  registerEditorPlugin(mounted.editor, createAnchorVisibilityPlugin())
  // Registering runs no transaction; touch the doc so the plugin has scanned it.
  return mounted
}

const blockTexts = (editor: ReturnType<typeof mountTestEditor>['editor']): string[] =>
  editor.document.map((b) => (b.content as Array<{ text: string }>).map((c) => c.text).join(''))

function caretAt(view: EditorView, text: string, offset: number): void {
  view.state.doc.descendants((node, pos) => {
    if (node.isTextblock && node.textContent === text) {
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, pos + 1 + offset))
      )
    }
  })
}

describe('anchor visibility', () => {
  it('hides the trailing anchor in the DOM and keeps it in the text', () => {
    const { editor, view } = mount([para('Hello ^abc123'), para('plain')])
    editor.replaceBlocks(editor.document, [para('Hello ^abc123'), para('plain')])

    const hidden = view.dom.querySelectorAll<HTMLElement>(`.${ANCHOR_HIDDEN_CLASS}`)
    expect(hidden).toHaveLength(1)
    expect(hidden[0].textContent).toBe(' ^abc123')
    expect(hidden[0].style.display).toBe('none')
    expect(blockTexts(editor)[0]).toBe('Hello ^abc123')
  })

  it('moves a caret that lands in the hidden anchor back before it', () => {
    const { editor, view } = mount([para('Hello ^abc123')])
    editor.replaceBlocks(editor.document, [para('Hello ^abc123')])

    caretAt(view, 'Hello ^abc123', 'Hello ^abc123'.length)

    expect(view.state.selection.$head.parentOffset).toBe('Hello'.length)
  })

  it('keeps the anchor on the first half when a block is split mid-text', () => {
    const { editor, view } = mount([para('Hello world ^abc123')])
    editor.replaceBlocks(editor.document, [para('Hello world ^abc123')])
    const firstId = editor.document[0].id
    caretAt(view, 'Hello world ^abc123', 'Hello'.length)

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    expect(blockTexts(editor).map((t) => t.trim())).toEqual(['Hello ^abc123', 'world'])
    expect(editor.document[0].id).toBe(firstId)
  })

  it('keeps the anchor last when another block is joined onto its block', () => {
    const { editor, view } = mount([para('Hello ^abc123'), para('world')])
    editor.replaceBlocks(editor.document, [para('Hello ^abc123'), para('world')])
    caretAt(view, 'world', 0)

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
    )

    expect(blockTexts(editor)).toEqual(['Helloworld ^abc123'])
  })

  it('strips the anchor of a block pasted next to the block that already has it', () => {
    const { editor } = mount([para('Original ^abc123')])
    editor.replaceBlocks(editor.document, [para('Original ^abc123')])

    editor.insertBlocks([para('Pasted copy ^abc123')], editor.document[0], 'after')

    expect(blockTexts(editor).map((t) => t.trim())).toEqual(['Original ^abc123', 'Pasted copy'])
  })

  it('leaves a moved block alone: its anchor is not a duplicate', () => {
    const { editor } = mount([para('a ^abc123'), para('b')])
    editor.replaceBlocks(editor.document, [para('a ^abc123'), para('b')])

    editor.insertBlocks([para('moved ^zzz999')], editor.document[1], 'after')

    expect(blockTexts(editor)).toEqual(['a ^abc123', 'b', 'moved ^zzz999'])
  })
})
