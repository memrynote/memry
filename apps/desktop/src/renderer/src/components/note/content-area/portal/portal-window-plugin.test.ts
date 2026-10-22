/**
 * The portal window on a real BlockNote editor bound to a real Y.Doc: what is
 * hidden, what the window reports, and what a local edit may not delete.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { BlockNoteEditor, type PartialBlock } from '@blocknote/core'
import * as Y from 'yjs'
import { CRDT_FRAGMENT_NAME } from '@memry/contracts/ipc-crdt'
import { TextSelection } from '@tiptap/pm/state'
import type { EditorView } from '@tiptap/pm/view'

// pdf.js touches `DOMMatrix` at import time and jsdom has none.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { editorSchema } from '../editor-schema'
import { withCollaborationIfLive } from '../collaboration-options'
import { registerEditorPlugin } from '../register-editor-plugin'
import {
  PORTAL_ANCESTOR_CLASS,
  PORTAL_ANCHOR_CLASS,
  PORTAL_HIDDEN_CLASS,
  createPortalWindowPlugin,
  portalWindowKey,
  setPortalWindowSpec,
  type PortalWindowSpec
} from './portal-window-plugin'

const mounted: Array<{ editor: BlockNoteEditor; el: HTMLElement; doc: Y.Doc }> = []

afterEach(() => {
  for (const { editor, el, doc } of mounted.splice(0)) {
    editor.unmount()
    el.remove()
    doc.destroy()
  }
})

const para = (text: string, children?: PartialBlock[]): PartialBlock =>
  ({ type: 'paragraph', content: text, children }) as PartialBlock

function mountWindow(blocks: PartialBlock[], spec: PortalWindowSpec) {
  const doc = new Y.Doc()
  const editor = BlockNoteEditor.create(
    withCollaborationIfLive(doc.getXmlFragment(CRDT_FRAGMENT_NAME), { schema: editorSchema })
  ) as unknown as BlockNoteEditor
  const el = document.createElement('div')
  document.body.appendChild(el)
  editor.mount(el)
  mounted.push({ editor, el, doc })
  editor.replaceBlocks(editor.document, blocks)

  const resolved: Array<{ rootFound: boolean | null; rootText: string | null }> = []
  registerEditorPlugin(
    editor,
    createPortalWindowPlugin(spec, (r) => resolved.push(r))
  )
  const view = (editor as unknown as { _tiptapEditor: { view: EditorView } })._tiptapEditor.view
  return { editor, view, el, resolved }
}

/** Text of every block the window does not show, outermost first. */
function hiddenTexts(el: HTMLElement): string[] {
  return [...el.querySelectorAll(`.${PORTAL_HIDDEN_CLASS}`)].map(
    (node) => node.textContent?.trim() ?? ''
  )
}

describe('portal window plugin', () => {
  it('hides everything outside the anchored block and its subtree', () => {
    const { el, resolved } = mountWindow(
      [
        para('before'),
        para('Chloroplast ^chl7', [para('converts light'), para('stroma')]),
        para('after')
      ],
      { anchor: 'chl7', hidden: [] }
    )

    expect(hiddenTexts(el)).toEqual(['before', 'after'])
    expect(resolved.at(-1)).toEqual({ rootFound: true, rootText: 'Chloroplast' })
  })

  it('drops a hidden child with its descendants, and never the root', () => {
    const { el } = mountWindow(
      [
        para('Root ^root1', [
          para('kept'),
          para('drop me ^drop1', [para('nested under dropped')]),
          para('also kept')
        ])
      ],
      { anchor: 'root1', hidden: ['drop1', 'root1'] }
    )

    expect(hiddenTexts(el)).toEqual(['drop me ^drop1nested under dropped'])
    expect(el.textContent).toContain('Root')
  })

  it('keeps the ancestors of a nested root as passages, without their own text', () => {
    const { el } = mountWindow(
      [para('Parent', [para('Target ^tgt11', [para('child')])]), para('Elsewhere')],
      { anchor: 'tgt11', hidden: [] }
    )

    const ancestor = el.querySelector(`.${PORTAL_ANCESTOR_CLASS}`)
    expect(ancestor).not.toBeNull()
    expect(hiddenTexts(el)).toEqual(['Parent', 'Elsewhere'])
    expect(el.querySelector(`.${PORTAL_ANCESTOR_CLASS} .bn-block-group`)?.textContent).toContain(
      'Target'
    )
  })

  it('shows a whole note except its hidden anchors', () => {
    const { el, resolved } = mountWindow([para('one'), para('two ^two22'), para('three')], {
      anchor: null,
      hidden: ['two22']
    })

    expect(hiddenTexts(el)).toEqual(['two ^two22'])
    expect(resolved.at(-1)).toEqual({ rootFound: null, rootText: null })
  })

  it('mutes the anchor text of blocks it shows', () => {
    const { el } = mountWindow([para('Chloroplast ^chl7')], { anchor: 'chl7', hidden: [] })

    expect(el.querySelector(`.${PORTAL_ANCHOR_CLASS}`)?.textContent).toBe('^chl7')
  })

  it('reports a missing anchor and shows nothing', () => {
    const { el, resolved } = mountWindow([para('a'), para('b')], { anchor: 'gone1', hidden: [] })

    expect(resolved.at(-1)).toEqual({ rootFound: false, rootText: null })
    expect(hiddenTexts(el)).toEqual(['a', 'b'])
  })

  it('follows a new spec', () => {
    const { el, view } = mountWindow([para('one'), para('two ^two22')], {
      anchor: null,
      hidden: []
    })
    expect(hiddenTexts(el)).toEqual([])

    setPortalWindowSpec(view, { anchor: null, hidden: ['two22'] })

    expect(hiddenTexts(el)).toEqual(['two ^two22'])
  })

  it('refuses a local edit that deletes a hidden block whole, and allows visible edits', () => {
    const { editor, view } = mountWindow([para('keep'), para('secret ^sec11'), para('also keep')], {
      anchor: null,
      hidden: ['sec11']
    })
    const state = portalWindowKey.getState(view.state)!
    const span = state.protectedSpans[0]

    view.dispatch(view.state.tr.delete(span.from, span.to))
    expect(editor.document.map((b) => b.id).length).toBe(3)

    const first = editor.document[0]
    editor.updateBlock(first, { content: 'edited' })
    expect(JSON.stringify(editor.document[0].content)).toContain('edited')
  })

  it('narrows Select All to the blocks the window shows', () => {
    const { view } = mountWindow([para('outside'), para('Root ^root1', [para('inside')])], {
      anchor: 'root1',
      hidden: []
    })

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    )

    const { from, to } = view.state.selection
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.doc.textBetween(from, to, '|')).toBe('Root ^root1|inside')
  })
})
