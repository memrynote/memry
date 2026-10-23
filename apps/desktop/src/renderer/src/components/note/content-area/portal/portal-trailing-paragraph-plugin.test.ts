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
import { createPortalTrailingParagraphPlugin } from './portal-trailing-paragraph-plugin'
import { createPortalKeysPlugin, prependPlugin } from './portal-keys-plugin'
import { mountTestEditor, para, unmountTestEditors } from './portal-test-editor'

afterEach(unmountTestEditors)

const FENCE = '{"v":1,"note":"src"}'
const portal = (children?: PartialBlock[]): PartialBlock =>
  ({
    type: 'codeBlock',
    props: { language: 'memry-portal' },
    content: FENCE,
    children
  }) as PartialBlock

const types = (editor: ReturnType<typeof mountTestEditor>['editor']): string[] =>
  editor.document.map((block) =>
    block.type === 'codeBlock' ? (block.props as { language: string }).language : block.type
  )

describe('portal trailing paragraph', () => {
  it('adds an empty paragraph when the document ends in a portal', () => {
    const { editor } = mountTestEditor([para('Intro')])
    registerEditorPlugin(editor, createPortalTrailingParagraphPlugin())
    editor.insertBlocks([portal()], editor.document[0], 'after')
    expect(types(editor)).toEqual(['paragraph', 'memry-portal', 'paragraph'])
  })

  it('adds the paragraph for a document that is only a portal, once the editor loads it', async () => {
    const { editor } = mountTestEditor([portal()])
    registerEditorPlugin(editor, createPortalTrailingParagraphPlugin())
    await Promise.resolve()
    expect(types(editor)).toEqual(['memry-portal', 'paragraph'])
  })

  it('puts the paragraph after the last nested portal, as its sibling', () => {
    const { editor } = mountTestEditor([para('Intro', [portal()])])
    registerEditorPlugin(editor, createPortalTrailingParagraphPlugin())
    editor.insertBlocks([para('x')], editor.document[0], 'after')
    editor.removeBlocks([editor.document[1]])
    expect(editor.document[0].children.map((b) => b.type)).toEqual(['codeBlock', 'paragraph'])
  })

  it('leaves a document alone when a paragraph already follows the portal', () => {
    const { editor } = mountTestEditor([portal(), para('after')])
    registerEditorPlugin(editor, createPortalTrailingParagraphPlugin())
    editor.insertBlocks([para('more')], editor.document[1], 'after')
    expect(editor.document).toHaveLength(3)
  })
})

describe('portal definition guard', () => {
  function setup() {
    const mounted = mountTestEditor([para('Intro'), portal()])
    registerEditorPlugin(mounted.editor, createPortalKeysPlugin(mounted.editor), prependPlugin)
    registerEditorPlugin(mounted.editor, createPortalTrailingParagraphPlugin())
    mounted.view.dispatch(
      mounted.view.state.tr.setSelection(TextSelection.create(mounted.view.state.doc, 2))
    )
    return mounted
  }

  it('turns a keyboard move into the definition into a node selection', () => {
    const { view } = setup()
    let inside = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') inside = pos + 1
    })
    view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, inside)))
    expect(view.state.selection).toBeInstanceOf(NodeSelection)
  })

  it('keeps a press on the definition as the opt-in', () => {
    const { view } = setup()
    let inside = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'codeBlock') inside = pos + 1
    })
    view.dispatch(
      view.state.tr
        .setSelection(TextSelection.create(view.state.doc, inside))
        .setMeta('pointer', true)
    )
    expect(view.state.selection).toBeInstanceOf(TextSelection)
  })

  it('types after a selected portal instead of editing the fence', () => {
    const { editor, view } = setup()
    let at = -1
    view.state.doc.descendants((node, pos) => {
      if (node.type.name === 'blockContainer' && node.firstChild?.type.name === 'codeBlock') {
        at = pos
      }
    })
    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, at)))
    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'h', bubbles: true, cancelable: true })
    )
    expect(
      editor.document.map((b) => (b.type === 'codeBlock' ? 'portal' : JSON.stringify(b.content)))
    ).toContain('[{"type":"text","text":"h","styles":{}}]')
    const portalBlock = editor.document.find((b) => b.type === 'codeBlock')
    expect(JSON.stringify(portalBlock?.content)).toContain(JSON.stringify(FENCE).slice(1, -1))
    expect(editor.document.at(-1)?.type).toBe('paragraph')
  })
})
