import { afterEach, describe, expect, it } from 'vitest'
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import { TextSelection } from '@tiptap/pm/state'
import { FOOTNOTE_PLUGIN_KEY, createFootnotePlugin } from './footnote-decorations'

// A real mounted editor: the feature is decorations, which exist only with a view.

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement }> = []

afterEach(() => {
  for (const { editor, el } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
  }
})

function mountEditor(initialContent: PartialBlock[]): BlockNoteEditor {
  const editor = BlockNoteEditor.create({ initialContent })
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  ;(editor as any)._tiptapEditor.registerPlugin(createFootnotePlugin())
  mounted.push({ editor, el })
  return editor
}

function view(editor: BlockNoteEditor) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor as any)._tiptapEditor.view
}

function markers(el: HTMLElement): Array<[string, string | undefined, boolean]> {
  return [...el.querySelectorAll<HTMLElement>('.footnote-ref')].map((node) => [
    node.textContent ?? '',
    node.dataset.footnoteNumber,
    node.classList.contains('footnote-ref-editing')
  ])
}

const NOTE: PartialBlock[] = [
  { type: 'paragraph', content: 'Second[^b] first[^a] again[^b] and missing[^x].' },
  { type: 'paragraph', content: 'Code ' },
  { type: 'paragraph', content: '[^a]: Alpha [[Source]].' },
  { type: 'paragraph', content: '[^b]: Beta.' }
]

describe('footnote decorations', () => {
  it('numbers references by first use and leaves an undefined one as text', () => {
    const editor = mountEditor(NOTE)
    expect(markers(editor.domElement as HTMLElement)).toEqual([
      ['[^b]', '1', false],
      ['[^a]', '2', false],
      ['[^b]', '1', false]
    ])
  })

  it('marks each definition line, keeping its raw text', () => {
    const editor = mountEditor(NOTE)
    const defs = [...(editor.domElement as HTMLElement).querySelectorAll('.footnote-def')]
    expect(defs.map((node) => node.textContent)).toEqual(['[^a]: Alpha [[Source]].', '[^b]: Beta.'])
  })

  it('shows the raw reference while the caret is inside it', () => {
    const editor = mountEditor(NOTE)
    const pmView = view(editor)
    let refPos = -1
    pmView.state.doc.descendants((node: { isText: boolean; text?: string }, pos: number) => {
      if (refPos === -1 && node.isText && node.text?.includes('[^a]'))
        refPos = pos + node.text.indexOf('[^a]') + 2
    })
    pmView.dispatch(pmView.state.tr.setSelection(TextSelection.create(pmView.state.doc, refPos)))
    expect(markers(editor.domElement as HTMLElement)[1]).toEqual(['[^a]', '2', true])
  })

  it('exposes each definition for the hover card', () => {
    const editor = mountEditor(NOTE)
    const state = FOOTNOTE_PLUGIN_KEY.getState(view(editor).state)
    expect(state?.definitions.get('a')).toEqual({ number: 2, text: 'Alpha [[Source]].' })
    expect(state?.definitions.get('b')).toEqual({ number: 1, text: 'Beta.' })
  })

  it('ignores a reference written in inline code', () => {
    const editor = mountEditor([
      { type: 'paragraph', content: [{ type: 'text', text: 'x[^a]', styles: { code: true } }] },
      { type: 'paragraph', content: '[^a]: Alpha.' }
    ])
    expect(markers(editor.domElement as HTMLElement)).toEqual([])
  })
})
