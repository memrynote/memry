/**
 * The portal window on a real BlockNote editor bound to a real Y.Doc: what is
 * shown (the v1 visibility rule), what the window reports, and what a local
 * edit may not delete or move out.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import { TextSelection } from '@tiptap/pm/state'
import type { PortalOpen } from '@memry/shared/portal-block'

// pdf.js touches `DOMMatrix` at import time and jsdom has none.
vi.mock('react-pdf', () => ({
  Document: () => null,
  Page: () => null,
  pdfjs: { GlobalWorkerOptions: { workerSrc: '' } }
}))
vi.mock('@/lib/url-metadata', () => ({
  fetchLinkPreview: vi.fn().mockResolvedValue({ domain: '', title: '', favicon: '' })
}))

import { para, unmountTestEditors } from './portal-test-editor'
import { mountPortalWindow } from './portal-window-test-editor'
import {
  PORTAL_ANCESTOR_CLASS,
  PORTAL_HIDDEN_CLASS,
  getPortalWindowState,
  portalWindowKey,
  setPortalWindowSpec,
  type PortalWindowSpec
} from './portal-window-plugin'

afterEach(unmountTestEditors)

const blocksTarget = (
  blocks: string[],
  open: Record<string, PortalOpen> = {}
): PortalWindowSpec => ({ kind: 'blocks', note: 'src', blocks, open })

/** Text of every block the window does not show, outermost first. */
function hiddenTexts(el: HTMLElement): string[] {
  return [...el.querySelectorAll(`.${PORTAL_HIDDEN_CLASS}`)].map(
    (node) => node.textContent?.trim() ?? ''
  )
}

const mount = (blocks: Parameters<typeof mountPortalWindow>[0], spec: PortalWindowSpec) => {
  const mounted = mountPortalWindow(blocks, spec)
  return { ...mounted, el: mounted.view.dom }
}

describe('portal window plugin', () => {
  it('shows a collapsed root alone and hides its children and the rest of the note', () => {
    const { el, view, resolved } = mount(
      [
        para('before'),
        para('Chloroplast ^chl7', [para('converts light'), para('stroma')]),
        para('after')
      ],
      blocksTarget(['chl7'])
    )

    expect(hiddenTexts(el)).toEqual(['before', 'converts light', 'stroma', 'after'])
    expect(getPortalWindowState(view)?.visible.map((b) => b.text)).toEqual(['Chloroplast'])
    expect(resolved.at(-1)).toEqual({ rootFound: true, rootText: 'Chloroplast' })
  })

  it('shows children by the open entry: hide-mode drops the listed, show-mode keeps only the listed', () => {
    const doc = [
      para('Root ^root1', [
        para('one ^one11'),
        para('two ^two22', [para('under two')]),
        para('three ^thr33')
      ])
    ]
    const hide = mount(doc, blocksTarget(['root1'], { root1: { mode: 'hide', ids: ['two22'] } }))
    expect(getPortalWindowState(hide.view)?.visible.map((b) => b.text)).toEqual([
      'Root',
      'one',
      'three'
    ])
    expect(hiddenTexts(hide.el)).toEqual(['two ^two22under two'])

    const show = mount(doc, blocksTarget(['root1'], { root1: { mode: 'show', ids: ['two22'] } }))
    expect(getPortalWindowState(show.view)?.visible.map((b) => b.text)).toEqual(['Root', 'two'])
  })

  it('reports hidden siblings and hidden children, and the path to the first root', () => {
    const { view } = mount(
      [
        para('Grandparent ^gra11', [
          para('Parent ^par22', [
            para('Root ^root1', [para('kid a ^kida1'), para('kid b ^kidb2')]),
            para('Sibling ^sib33')
          ])
        ])
      ],
      blocksTarget(['root1'], { root1: { mode: 'show', ids: ['kida1'] } })
    )
    const state = getPortalWindowState(view)!

    expect(state.visible.map((b) => b.text)).toEqual(['Root', 'kid a'])
    expect(state.hiddenSiblings.map((b) => b.text)).toEqual(['Sibling'])
    const rootId = state.visible[0].blockId
    expect(state.hiddenChildren[rootId].map((b) => b.text)).toEqual(['kid b'])
    expect(state.ancestors.map((b) => b.text)).toEqual(['Grandparent', 'Parent'])
    expect(state.visible[0]).toMatchObject({ anchor: 'root1', depth: 2 })
  })

  it('keeps the ancestors of a nested root as passages, without their own text', () => {
    const { el } = mount(
      [para('Parent', [para('Target ^tgt11', [para('child')])]), para('Elsewhere')],
      blocksTarget(['tgt11'])
    )

    expect(el.querySelector(`.${PORTAL_ANCESTOR_CLASS}`)).not.toBeNull()
    expect(hiddenTexts(el)).toEqual(['Parent', 'child', 'Elsewhere'])
    expect(el.querySelector(`.${PORTAL_ANCESTOR_CLASS} .bn-block-group`)?.textContent).toContain(
      'Target'
    )
  })

  it('shows several roots in document order', () => {
    const { view } = mount(
      [para('a ^aaa11'), para('skipped'), para('b ^bbb22')],
      blocksTarget(['bbb22', 'aaa11'])
    )

    expect(getPortalWindowState(view)?.visible.map((b) => b.text)).toEqual(['a', 'b'])
  })

  it('shows a whole note and reports no root', () => {
    const { el, resolved } = mount([para('one'), para('two ^two22')], {
      kind: 'note',
      note: 'src',
      hide: []
    })

    expect(hiddenTexts(el)).toEqual([])
    expect(resolved.at(-1)).toEqual({ rootFound: null, rootText: 'one' })
  })

  it('hides a denied block with its subtree and lists the outermost as hidden', () => {
    const { el, view } = mount(
      [
        para('one ^one111', [para('child')]),
        para('two ^two222', [para('kid ^kid111')]),
        para('end')
      ],
      { kind: 'note', note: 'src', hide: ['two222', 'kid111', 'nope11'] }
    )
    const state = getPortalWindowState(view)!

    expect(hiddenTexts(el)).toHaveLength(1)
    expect(hiddenTexts(el)[0]).toContain('kid')
    expect(state.visible.map((b) => b.text)).toEqual(['one', 'child', 'end'])
    expect(state.hiddenSiblings.map((b) => b.text)).toEqual(['two'])
    expect(state.hiddenChildren).toEqual({})
  })

  it('gives a hidden nested block of a note portal its source ancestors, outermost first', () => {
    const { view } = mount(
      [para('Unit ^unit11', [para('DNA', [para('helix ^hel111')])]), para('end')],
      { kind: 'note', note: 'src', hide: ['hel111'] }
    )
    const [hidden] = getPortalWindowState(view)!.hiddenSiblings

    expect(hidden.text).toBe('helix')
    expect(hidden.ancestorTexts).toEqual(['Unit', 'DNA'])
  })

  it('reports a missing anchor and shows nothing', () => {
    const { el, resolved } = mount([para('a'), para('b')], blocksTarget(['gone1']))

    expect(resolved.at(-1)).toEqual({ rootFound: false, rootText: null })
    expect(hiddenTexts(el)).toEqual(['a', 'b'])
  })

  it('follows a new target', () => {
    const { el, view } = mount([para('one ^one11'), para('two ^two22')], blocksTarget(['one11']))
    expect(hiddenTexts(el)).toEqual(['two ^two22'])

    setPortalWindowSpec(view, blocksTarget(['one11', 'two22']))

    expect(hiddenTexts(el)).toEqual([])
  })

  it('refuses a local edit that deletes a hidden block whole, and allows visible edits', () => {
    const { editor, view } = mount(
      [para('keep ^kee11'), para('secret'), para('also keep ^kee22')],
      blocksTarget(['kee11', 'kee22'])
    )
    const span = portalWindowKey.getState(view.state)!.protectedSpans[0]

    view.dispatch(view.state.tr.delete(span.from, span.to))
    expect(editor.document).toHaveLength(3)

    editor.updateBlock(editor.document[0], { content: 'edited ^kee11' })
    expect(JSON.stringify(editor.document[0].content)).toContain('edited')
  })

  it('refuses a join with hidden content and a lift out of the window', () => {
    const { editor, view } = mount(
      [para('hidden before'), para('Root ^root1', [para('kid ^kid11')])],
      blocksTarget(['root1'], { root1: { mode: 'hide', ids: [] } })
    )
    const before = editor.document.map((b) => b.id)

    // Join "Root" into the hidden block above it.
    let rootStart = -1
    view.state.doc.descendants((node, pos) => {
      if (node.isTextblock && node.textContent.startsWith('Root')) rootStart = pos
    })
    view.dispatch(view.state.tr.delete(rootStart - 2, rootStart + 1))
    expect(editor.document.map((b) => b.id)).toEqual(before)

    // Lift the child out of the root: it would land among the hidden siblings.
    editor.setTextCursorPosition(editor.document[1].children[0], 'start')
    editor.unnestBlock()
    expect(editor.document[1].children).toHaveLength(1)
  })

  it('narrows Select All to the blocks the window shows', () => {
    const { view } = mount(
      [para('outside'), para('Root ^root1', [para('inside')])],
      blocksTarget(['root1'], { root1: { mode: 'hide', ids: [] } })
    )

    view.dom.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'a', metaKey: true, bubbles: true, cancelable: true })
    )

    const { from, to } = view.state.selection
    expect(view.state.selection).toBeInstanceOf(TextSelection)
    expect(view.state.doc.textBetween(from, to, '|')).toBe('Root ^root1|inside')
  })
})
