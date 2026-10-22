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

import { ySyncPluginKey } from 'y-prosemirror'
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

  it('gives the anchor to the second half when a block is split at its very start', () => {
    const { editor, view } = mount([para('Hello world ^abc123')])
    editor.replaceBlocks(editor.document, [para('Hello world ^abc123')])
    caretAt(view, 'Hello world ^abc123', 0)

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    expect(blockTexts(editor).map((t) => t.trim())).toEqual(['', 'Hello world ^abc123'])
  })

  it('keeps the anchor on the original text when a block is split at its visible end', () => {
    const { editor, view } = mount([para('Hello ^abc123')])
    editor.replaceBlocks(editor.document, [para('Hello ^abc123')])
    caretAt(view, 'Hello ^abc123', 'Hello'.length)

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
    )

    expect(blockTexts(editor).map((t) => t.trim())).toEqual(['Hello ^abc123', ''])
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

  describe('typing around the hidden anchor', () => {
    const TEXT = 'DNA ^dna1'

    function mountOne(text = TEXT) {
      const m = mount([para(text)])
      m.editor.replaceBlocks(m.editor.document, [para(text)])
      return m
    }

    /** End of the whole text, past the hidden anchor: where a stale caret would type. */
    const rawEnd = (view: EditorView): number => {
      let end = 0
      view.state.doc.descendants((node, pos) => {
        if (node.isTextblock && end === 0) end = pos + 1 + node.content.size
      })
      return end
    }

    /** What ProseMirror does with a typed character: custom handlers first, then a plain insert. */
    function typeAt(view: EditorView, at: number, text: string): void {
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, at, at, text, () => view.state.tr)
      )
      if (!handled) view.dispatch(view.state.tr.insertText(text, at))
    }

    it('End then immediate typing lands before the anchor', () => {
      const { editor, view } = mountOne()
      view.dom.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))
      typeAt(view, rawEnd(view), 'x')
      expect(blockTexts(editor)).toEqual(['DNAx ^dna1'])
    })

    it('typing five characters in one tick with a stale caret keeps the anchor intact', () => {
      const { editor, view } = mountOne()
      for (const ch of 'abcde') typeAt(view, rawEnd(view), ch)
      expect(blockTexts(editor)).toEqual(['DNAabcde ^dna1'])
      expect(view.state.selection.$head.parentOffset).toBe('DNAabcde'.length)
    })

    it('click at the end of the visible text: a caret reported after the anchor types before it', () => {
      const { editor, view } = mountOne()
      typeAt(view, rawEnd(view), ' typed')
      expect(blockTexts(editor)).toEqual(['DNA typed ^dna1'])
    })

    it('IME composition start moves a DOM caret that sits after the hidden anchor', () => {
      const { editor, view } = mountOne()
      view.focus()
      const textNodes: Text[] = []
      const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT)
      for (let n = walker.nextNode(); n; n = walker.nextNode()) textNodes.push(n as Text)
      const last = textNodes[textNodes.length - 1]
      document.getSelection()?.collapse(last, last.length)
      view.dom.dispatchEvent(new Event('compositionstart', { bubbles: true }))
      typeAt(view, view.state.selection.from, '\u3042\u3044')
      expect(blockTexts(editor)).toEqual(['DNA\u3042\u3044 ^dna1'])
    })

    it('IME-style multi-character insertion after the anchor is redirected', () => {
      const { editor, view } = mountOne()
      typeAt(view, rawEnd(view), '\u3042\u3044\u3046')
      expect(blockTexts(editor)).toEqual(['DNA\u3042\u3044\u3046 ^dna1'])
    })

    it('paste at the end lands before the anchor', () => {
      const { editor, view } = mountOne()
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, rawEnd(view))))
      class FakeTransfer {
        types = ['text/plain']
        getData = (type: string): string => (type === 'text/plain' ? 'pasted' : '')
      }
      class FakeClipboardEvent extends Event {
        clipboardData = new FakeTransfer()
      }
      vi.stubGlobal('DataTransfer', FakeTransfer)
      vi.stubGlobal('ClipboardEvent', FakeClipboardEvent)
      try {
        view.pasteText('pasted')
      } finally {
        vi.unstubAllGlobals()
      }
      expect(blockTexts(editor)).toEqual(['DNApasted ^dna1'])
    })

    it('Enter at the end keeps the anchor on the text-owning block', () => {
      const { editor, view } = mountOne()
      caretAt(view, TEXT, 'DNA'.length)
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
      expect(blockTexts(editor)).toEqual(['DNA ^dna1', ''])
    })

    it('Backspace at the visible end deletes the previous visible character', () => {
      const { editor, view } = mountOne()
      caretAt(view, TEXT, 'DNA'.length)
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      )
      expect(blockTexts(editor)).toEqual(['DN ^dna1'])
    })

    it('Delete at the visible end leaves the anchor alone', () => {
      const { editor, view } = mountOne()
      caretAt(view, TEXT, 'DNA'.length)
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Delete', bubbles: true, cancelable: true })
      )
      expect(blockTexts(editor)).toEqual([TEXT])
    })

    it('Select-All then typing replaces the visible text and keeps the anchor', () => {
      const { editor, view } = mountOne()
      const from = view.state.doc.resolve(rawEnd(view)).start()
      const handled = view.someProp('handleTextInput', (f) =>
        f(view, from, rawEnd(view), 'new', () => view.state.tr)
      )
      expect(handled).toBe(true)
      expect(blockTexts(editor)).toEqual(['new ^dna1'])
    })

    it('Select-All then Delete empties the text; the block keeps its address', () => {
      const { editor, view } = mountOne()
      const from = view.state.doc.resolve(rawEnd(view)).start()
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, from, rawEnd(view)))
      )
      view.dom.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Backspace', bubbles: true, cancelable: true })
      )
      expect(blockTexts(editor)).toEqual([' ^dna1'])
    })

    it('heals text that landed after a multi-character anchor in one undoable step', () => {
      const { editor, view } = mountOne('Lecture ^dna1')
      const end = rawEnd(view)
      view.dispatch(view.state.tr.insertText('QQZQZ', end))
      expect(blockTexts(editor)).toEqual(['LectureQQZQZ ^dna1'])
      expect(view.state.selection.$head.parentOffset).toBe('LectureQQZQZ'.length)
    })

    it('does not touch text after an anchor in a remote (y-sync) change', () => {
      const { editor, view } = mountOne('Lecture ^dna1')
      view.dispatch(
        view.state.tr
          .insertText('zz', rawEnd(view))
          .setMeta(ySyncPluginKey, { isChangeOrigin: true })
      )
      expect(blockTexts(editor)).toEqual(['Lecture ^dna1zz'])
    })
  })
})
